from __future__ import annotations

import argparse
import os
import glob
from pathlib import Path
import duckdb

def yyyymmdd_to_mmddyyyy(s: str) -> str:
    # "20251104" -> "11/04/2025"
    y = s[0:4]
    m = s[4:6]
    d = s[6:8]
    return f"{m}/{d}/{y}"

def mmddyyyy_to_iso(mmddyyyy: str) -> str:
    m, d, y = mmddyyyy.split("/")
    return f"{y}-{m.zfill(2)}-{d.zfill(2)}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ncvhis", default="data/raw/ncvhis/ncvhis_Statewide.txt")
    ap.add_argument("--ncvoter", default="data/raw/ncvoter/ncvoter_Statewide.txt")
    ap.add_argument("--voter_stats_glob", default="data/raw/voter_stats/voter_stats_*.txt")
    ap.add_argument("--out_csv", default="web/src/data/county_demographic_turnout_all.csv")
    ap.add_argument("--db_path", default="data/derived/nc_turnout.duckdb")
    ap.add_argument("--qa_dir", default="data/derived/qa")
    args = ap.parse_args()

    voter_stats_files = sorted(glob.glob(args.voter_stats_glob))
    if not voter_stats_files:
        raise SystemExit(
            f"No voter_stats files found at {args.voter_stats_glob}. "
            "Expected files like voter_stats_YYYYMMDD.txt"
        )

    Path(args.qa_dir).mkdir(parents=True, exist_ok=True)
    Path(os.path.dirname(args.out_csv)).mkdir(parents=True, exist_ok=True)
    Path(os.path.dirname(args.db_path)).mkdir(parents=True, exist_ok=True)

    con = duckdb.connect(database=args.db_path)
    con.execute("PRAGMA threads=4;")
    con.execute("PRAGMA enable_progress_bar=true;")

    # ------------------------------------------------------------
    # 0) Load core tables ONCE (ncvhis_raw, ncvoter_attrs)
    # ------------------------------------------------------------
    con.execute("DROP TABLE IF EXISTS ncvhis_raw;")
    con.execute(
        """
        CREATE TABLE ncvhis_raw AS
        SELECT
            replace(trim(column3), '"', '') AS election_lbl,
            replace(trim(column10), '"', '') AS ncid,
            upper(replace(trim(column1), '"', '')) AS county_desc
        FROM read_csv(
            ?, delim='\\t', header=false, quote='', escape='',
            strict_mode=false, ignore_errors=true, null_padding=true, max_line_size=10000000,
            columns={
                'column0':'VARCHAR','column1':'VARCHAR','column2':'VARCHAR','column3':'VARCHAR',
                'column4':'VARCHAR','column5':'VARCHAR','column6':'VARCHAR','column7':'VARCHAR',
                'column8':'VARCHAR','column9':'VARCHAR','column10':'VARCHAR','column11':'VARCHAR',
                'column12':'VARCHAR','column13':'VARCHAR','column14':'VARCHAR'
            }
        )
        WHERE election_lbl IS NOT NULL
          AND length(trim(election_lbl)) > 0
          AND lower(trim(election_lbl)) != 'election_lbl'
          AND ncid IS NOT NULL
          AND length(trim(ncid)) > 0
          AND lower(trim(ncid)) != 'ncid'
        """,
        [args.ncvhis],
    )

    con.execute("DROP TABLE IF EXISTS ncvoter_attrs;")
    con.execute(
        """
        CREATE TABLE ncvoter_attrs AS
        SELECT
            replace(trim(column3), '"', '') AS ncid,
            upper(replace(trim(column1), '"', '')) AS reg_county_desc,
            replace(trim(column28), '"', '') AS party_cd,
            replace(trim(column26), '"', '') AS race_code,
            replace(trim(column27), '"', '') AS ethnic_code,
            replace(trim(column29), '"', '') AS sex_code,
            replace(trim(column30), '"', '') AS birth_year
        FROM read_csv(
            ?, delim='\\t', header=false, quote='', escape='',
            strict_mode=false, ignore_errors=true, null_padding=true, max_line_size=10000000,
            columns={
                'column0':'VARCHAR','column1':'VARCHAR','column2':'VARCHAR','column3':'VARCHAR',
                'column4':'VARCHAR','column5':'VARCHAR','column6':'VARCHAR','column7':'VARCHAR',
                'column8':'VARCHAR','column9':'VARCHAR','column10':'VARCHAR','column11':'VARCHAR',
                'column12':'VARCHAR','column13':'VARCHAR','column14':'VARCHAR','column15':'VARCHAR',
                'column16':'VARCHAR','column17':'VARCHAR','column18':'VARCHAR','column19':'VARCHAR',
                'column20':'VARCHAR','column21':'VARCHAR','column22':'VARCHAR','column23':'VARCHAR',
                'column24':'VARCHAR','column25':'VARCHAR','column26':'VARCHAR','column27':'VARCHAR',
                'column28':'VARCHAR','column29':'VARCHAR','column30':'VARCHAR','column31':'VARCHAR',
                'column32':'VARCHAR','column33':'VARCHAR','column34':'VARCHAR','column35':'VARCHAR',
                'column36':'VARCHAR','column37':'VARCHAR','column38':'VARCHAR','column39':'VARCHAR',
                'column40':'VARCHAR','column41':'VARCHAR','column42':'VARCHAR','column43':'VARCHAR',
                'column44':'VARCHAR','column45':'VARCHAR','column46':'VARCHAR','column47':'VARCHAR',
                'column48':'VARCHAR','column49':'VARCHAR','column50':'VARCHAR','column51':'VARCHAR',
                'column52':'VARCHAR','column53':'VARCHAR','column54':'VARCHAR','column55':'VARCHAR',
                'column56':'VARCHAR','column57':'VARCHAR','column58':'VARCHAR','column59':'VARCHAR',
                'column60':'VARCHAR','column61':'VARCHAR','column62':'VARCHAR','column63':'VARCHAR',
                'column64':'VARCHAR','column65':'VARCHAR','column66':'VARCHAR'
            }
        )
        WHERE ncid IS NOT NULL AND length(trim(ncid)) > 0 AND lower(trim(ncid)) != 'ncid'
        """,
        [args.ncvoter],
    )

    # Output table that accumulates all elections
    con.execute("DROP TABLE IF EXISTS turnout_all;")
    con.execute(
        """
        CREATE TABLE turnout_all (
            election_date VARCHAR,
            county_desc VARCHAR,
            party_cd VARCHAR,
            race_code VARCHAR,
            ethnic_code VARCHAR,
            sex_code VARCHAR,
            age_group VARCHAR,
            registered_count BIGINT,
            voted_count BIGINT,
            turnout_rate DOUBLE
        );
        """
    )

    qa_rows = []

    # ------------------------------------------------------------
    # 1) Loop elections from voter_stats files
    # ------------------------------------------------------------
    for voter_stats_path in voter_stats_files:

        # expects .../voter_stats_YYYYMMDD.txt
        base = Path(voter_stats_path).name
        yyyymmdd = base.replace("voter_stats_", "").replace(".txt", "")
        if len(yyyymmdd) != 8 or not yyyymmdd.isdigit():
            print(f"[WARN] skipping unrecognized file name: {base}")
            continue

        election_mmddyyyy = yyyymmdd_to_mmddyyyy(yyyymmdd)
        election_iso = mmddyyyy_to_iso(election_mmddyyyy)
        election_year = int(election_iso.split("-")[0])

        print(f"\n[INFO] building election {election_iso} from {base}")

        # --- Denominator from voter_stats_YYYYMMDD.txt
        con.execute("DROP TABLE IF EXISTS voter_stats_raw;")
        con.execute(
            """
            CREATE TABLE voter_stats_raw AS
            SELECT
                upper(replace(trim(column0), '"', '')) AS county_desc,
                replace(trim(column1), '"', '') AS election_date_raw,
                replace(trim(column2), '"', '') AS stats_type,
                replace(trim(column5), '"', '') AS party_cd,
                replace(trim(column6), '"', '') AS race_code,
                replace(trim(column7), '"', '') AS ethnic_code,
                replace(trim(column8), '"', '') AS sex_code,
                replace(trim(column9), '"', '') AS age_group,
                TRY_CAST(replace(trim(column10), '"', '') AS BIGINT) AS total_voters
            FROM read_csv(
                ?, delim='\\t', header=false, quote='', escape='',
                columns={
                    'column0':'VARCHAR','column1':'VARCHAR','column2':'VARCHAR','column3':'VARCHAR',
                    'column4':'VARCHAR','column5':'VARCHAR','column6':'VARCHAR','column7':'VARCHAR',
                    'column8':'VARCHAR','column9':'VARCHAR','column10':'VARCHAR','column11':'VARCHAR'
                }
            )
            WHERE TRY_CAST(replace(trim(column10), '"', '') AS BIGINT) IS NOT NULL
            """,
            [voter_stats_path],
        )

        con.execute("DROP TABLE IF EXISTS voter_stats_denominator;")
        con.execute(
            """
            CREATE TABLE voter_stats_denominator AS
            SELECT
                ? AS election_date,
                county_desc,
                party_cd,
                race_code,
                ethnic_code,
                sex_code,
                age_group,
                SUM(total_voters) AS registered_count
            FROM voter_stats_raw
            WHERE election_date_raw = ?
              AND lower(stats_type) = 'voter'
            GROUP BY 1,2,3,4,5,6,7
            """,
            [election_iso, election_mmddyyyy],
        )

        # --- Numerator: voters who voted in election (dedupe NCID)
        con.execute("DROP TABLE IF EXISTS ncvhis_election;")
        con.execute(
            """
            CREATE TABLE ncvhis_election AS
            SELECT county_desc, election_lbl, ncid
            FROM ncvhis_raw
            WHERE election_lbl = ?
            """,
            [election_mmddyyyy],
        )

        con.execute("DROP TABLE IF EXISTS voted_ncids;")
        con.execute(
            """
            CREATE TABLE voted_ncids AS
            SELECT
                county_desc AS voted_county_desc,
                ncid
            FROM (
                SELECT county_desc, ncid,
                       row_number() OVER (PARTITION BY ncid ORDER BY county_desc) AS rn
                FROM ncvhis_election
            )
            WHERE rn = 1
            """
        )

        con.execute("DROP TABLE IF EXISTS voted_joined;")
        con.execute(
            """
            CREATE TABLE voted_joined AS
            SELECT
                v.voted_county_desc,
                a.reg_county_desc,
                v.ncid,
                a.party_cd,
                a.race_code,
                a.ethnic_code,
                a.sex_code,
                a.birth_year
            FROM voted_ncids v
            LEFT JOIN ncvoter_attrs a
              ON v.ncid = a.ncid
            """
        )

        qa = con.execute(
            """
            SELECT
                COUNT(*) AS total_voted,
                COUNT(*) FILTER (WHERE reg_county_desc IS NULL) AS join_mismatches,
                COUNT(*) FILTER (
                  WHERE reg_county_desc IS NOT NULL AND voted_county_desc != reg_county_desc
                ) AS county_mismatches
            FROM voted_joined
            """
        ).fetchone()

        total_voted, join_mismatches, county_mismatches = qa
        join_mismatch_rate = (join_mismatches / total_voted) if total_voted else 0.0
        county_mismatch_rate = ((county_mismatches) / (total_voted - join_mismatches)) if (total_voted - join_mismatches) else 0.0

        print(f"[INFO] voted (deduped ncid): {total_voted:,}")
        print(f"[INFO] join mismatches: {join_mismatches:,} ({join_mismatch_rate*100:.2f}%)")
        print(f"[INFO] county mismatches: {county_mismatches:,} ({county_mismatch_rate*100:.2f}%)")

        qa_rows.append((election_iso, election_mmddyyyy, total_voted, join_mismatches, join_mismatch_rate, county_mismatches, county_mismatch_rate))

        # --- Age bucket + aggregate
        con.execute("DROP TABLE IF EXISTS voted_clean;")
        con.execute(
            """
            CREATE TABLE voted_clean AS
            SELECT
                reg_county_desc AS county_desc,
                party_cd,
                race_code,
                ethnic_code,
                sex_code,
                birth_year
            FROM voted_joined
            WHERE reg_county_desc IS NOT NULL
            """
        )

        con.execute("DROP TABLE IF EXISTS voted_with_age;")
        con.execute(
            """
            CREATE TABLE voted_with_age AS
            SELECT
                county_desc,
                party_cd,
                race_code,
                ethnic_code,
                sex_code,
                CASE
                    WHEN birth_year IS NULL OR length(trim(birth_year)) = 0 THEN 'Age < 18 Or Invalid Birth Dates'
                    WHEN TRY_CAST(trim(birth_year) AS INTEGER) IS NULL THEN 'Age < 18 Or Invalid Birth Dates'
                    ELSE
                        CASE
                            WHEN (? - CAST(trim(birth_year) AS INTEGER)) < 18 THEN 'Age < 18 Or Invalid Birth Dates'
                            WHEN (? - CAST(trim(birth_year) AS INTEGER)) BETWEEN 18 AND 25 THEN 'Age 18 - 25'
                            WHEN (? - CAST(trim(birth_year) AS INTEGER)) BETWEEN 26 AND 40 THEN 'Age 26 - 40'
                            WHEN (? - CAST(trim(birth_year) AS INTEGER)) BETWEEN 41 AND 65 THEN 'Age 41 - 65'
                            ELSE 'Age Over 66'
                        END
                END AS age_group
            FROM voted_clean
            """,
            [election_year, election_year, election_year, election_year],
        )

        con.execute("DROP TABLE IF EXISTS voted_aggregated;")
        con.execute(
            """
            CREATE TABLE voted_aggregated AS
            SELECT
                ? AS election_date,
                county_desc,
                party_cd,
                race_code,
                ethnic_code,
                sex_code,
                age_group,
                COUNT(*) AS voted_count
            FROM voted_with_age
            GROUP BY 1,2,3,4,5,6,7
            """,
            [election_iso],
        )

        # --- Join numerator/denominator and append to turnout_all
        con.execute("DROP TABLE IF EXISTS turnout_buckets;")
        con.execute(
            """
            CREATE TABLE turnout_buckets AS
            SELECT
                d.election_date,
                d.county_desc,
                d.party_cd,
                d.race_code,
                d.ethnic_code,
                d.sex_code,
                d.age_group,
                d.registered_count,
                COALESCE(v.voted_count, 0) AS voted_count,
                CASE WHEN d.registered_count = 0 THEN NULL
                     ELSE (COALESCE(v.voted_count, 0) * 1.0 / d.registered_count)
                END AS turnout_rate
            FROM voter_stats_denominator d
            LEFT JOIN voted_aggregated v
              ON d.election_date = v.election_date
             AND d.county_desc = v.county_desc
             AND d.party_cd = v.party_cd
             AND d.race_code = v.race_code
             AND d.ethnic_code = v.ethnic_code
             AND d.sex_code = v.sex_code
             AND d.age_group = v.age_group
            """
        )

        con.execute("INSERT INTO turnout_all SELECT * FROM turnout_buckets;")

    # ------------------------------------------------------------
    # 2) Export combined CSV
    # ------------------------------------------------------------
    con.execute(
        """
        COPY (
            SELECT
                election_date,
                county_desc,
                party_cd,
                race_code,
                ethnic_code,
                sex_code,
                age_group,
                registered_count,
                voted_count,
                turnout_rate
            FROM turnout_all
            ORDER BY election_date, county_desc, party_cd, race_code, ethnic_code, sex_code, age_group
        ) TO ? (HEADER, DELIMITER ',')
        """,
        [args.out_csv],
    )
    print(f"\n[OK] wrote combined: {args.out_csv}")

    # Optional QA summary across elections
    qa_path = Path(args.qa_dir) / "qa_summary_ALL.csv"
    con.execute("DROP TABLE IF EXISTS qa_all_tmp;")
    con.execute(
        """
        CREATE TABLE qa_all_tmp (
            election_date VARCHAR,
            election_lbl VARCHAR,
            total_voted_ncids BIGINT,
            join_mismatches_dropped BIGINT,
            join_mismatch_rate DOUBLE,
            county_mismatches_kept BIGINT,
            county_mismatch_rate DOUBLE
        );
        """
    )
    con.executemany("INSERT INTO qa_all_tmp VALUES (?, ?, ?, ?, ?, ?, ?)", qa_rows)
    con.execute("COPY qa_all_tmp TO ? (HEADER, DELIMITER ',')", [str(qa_path)])
    print(f"[OK] wrote QA: {qa_path}")

if __name__ == "__main__":
    main()
