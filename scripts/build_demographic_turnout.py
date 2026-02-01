from __future__ import annotations

import argparse
import os
from pathlib import Path
import duckdb


def mmddyyyy_to_iso(mmddyyyy: str) -> str:
    # expects "11/04/2025"
    m, d, y = mmddyyyy.split("/")
    return f"{y}-{m.zfill(2)}-{d.zfill(2)}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ncvhis", default="data/raw/ncvhis_Statewide.txt")
    ap.add_argument("--ncvoter", default="data/raw/ncvoter_Statewide.txt")
    ap.add_argument("--voter_stats", default="data/raw/voter_stats_20251104.txt")
    ap.add_argument("--election_mmddyyyy", default="11/04/2025")
    ap.add_argument("--out_csv", default="src/data/county_demographic_turnout_20251104.csv")
    ap.add_argument("--db_path", default="data/derived/nc_turnout.duckdb")
    ap.add_argument("--qa_dir", default="data/derived/qa")
    args = ap.parse_args()

    election_mmddyyyy = args.election_mmddyyyy
    election_iso = mmddyyyy_to_iso(election_mmddyyyy)
    election_year = int(election_iso.split("-")[0])

    Path(args.qa_dir).mkdir(parents=True, exist_ok=True)
    Path(os.path.dirname(args.out_csv)).mkdir(parents=True, exist_ok=True)
    Path(os.path.dirname(args.db_path)).mkdir(parents=True, exist_ok=True)

    con = duckdb.connect(database=args.db_path)

    # Speed + convenience
    con.execute("PRAGMA threads=4;")
    con.execute("PRAGMA enable_progress_bar=true;")

    # -----------------------
    # 1) Denominator: voter_stats
    # -----------------------
    # Layout (based on your examples):
    # county_desc, election_date, stats_type, precinct_abbrv, vtd_abbrv, party_cd, race_code,
    # ethnic_code, sex_code, age, total_voters, update_date
    con.execute("DROP TABLE IF EXISTS voter_stats_raw;")
    con.execute(
        """
        CREATE TABLE voter_stats_raw AS
        SELECT
            upper(replace(trim(column0), '"', '')) AS county_desc,
            replace(trim(column1), '"', '') AS election_date_raw,
            replace(trim(column2), '"', '') AS stats_type,
            replace(trim(column3), '"', '') AS precinct_abbrv,
            replace(trim(column4), '"', '') AS vtd_abbrv,
            replace(trim(column5), '"', '') AS party_cd,
            replace(trim(column6), '"', '') AS race_code,
            replace(trim(column7), '"', '') AS ethnic_code,
            replace(trim(column8), '"', '') AS sex_code,
            replace(trim(column9), '"', '') AS age_group,
            TRY_CAST(replace(trim(column10), '"', '') AS INTEGER) AS total_voters,
            replace(trim(column11), '"', '') AS update_date_raw
        FROM read_csv(
            ?, delim='\\t', header=false, quote='', escape='',
            columns={
                'column0':'VARCHAR','column1':'VARCHAR','column2':'VARCHAR','column3':'VARCHAR',
                'column4':'VARCHAR','column5':'VARCHAR','column6':'VARCHAR','column7':'VARCHAR',
                'column8':'VARCHAR','column9':'VARCHAR','column10':'VARCHAR','column11':'VARCHAR'
            }
        )
        WHERE TRY_CAST(replace(trim(column10), '"', '') AS INTEGER) IS NOT NULL
        """,
        [args.voter_stats],
    )

    con.execute("DROP TABLE IF EXISTS voter_stats_denominator;")
    con.execute(
        """
        CREATE TABLE voter_stats_denominator AS
        SELECT
            ? AS election_date, -- ISO
            county_desc,
            party_cd,
            race_code,
            ethnic_code,
            sex_code,
            age_group,
            SUM(total_voters) AS registered_count
        FROM voter_stats_raw
        WHERE replace(election_date_raw, '"', '') = ?
        AND lower(stats_type) = 'voter'
        GROUP BY 1,2,3,4,5,6,7
        """,
        [election_iso, election_mmddyyyy],
    )

    # -----------------------
    # 2) Numerator base: ncvhis filtered to election
    # -----------------------
    # Layout for ncvhis appears to be 15 columns (0..14)
    con.execute("DROP TABLE IF EXISTS ncvhis_raw;")
    con.execute(
        """
        CREATE TABLE ncvhis_raw AS
        SELECT
            trim(column3) AS election_lbl,
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
        WHERE trim(column3) IS NOT NULL AND length(trim(column3)) > 0
        """,
        [args.ncvhis],
    )
    # Debug: what election labels exist?
    print("[DEBUG] sample election_lbl values:")
    for row in con.execute(
        """
        SELECT election_lbl, COUNT(*) AS rows
        FROM ncvhis_raw
        GROUP BY 1
        ORDER BY 1 DESC
        LIMIT 15
        """
    ).fetchall():
        print("   ", row[0], row[1])

    #Debug: does anything match the target date loosely?
    like_count = con.execute(
        """
        SELECT COUNT(*)
        FROM ncvhis_raw
        WHERE election_lbl LIKE '%2025%'
        """
    ).fetchone()[0]
    print(f"[DEBUG] rows with election_lbl containing '2025': {like_count:,}")
    con.execute("DROP TABLE IF EXISTS ncvhis_election;")
    con.execute(
        """
        CREATE TABLE ncvhis_election AS
        SELECT
            county_desc,
            replace(election_lbl, '"', '') AS election_lbl,
            ncid
        FROM ncvhis_raw
        WHERE
            -- drop header-ish row if present
            lower(replace(election_lbl, '"', '')) != 'election_lbl'
            AND replace(election_lbl, '"', '') = ?
            AND ncid IS NOT NULL
            AND length(trim(ncid)) > 0
            AND lower(trim(ncid)) != 'ncid'
        """,
        [election_mmddyyyy],
    )



    # Dedupe to one row per NCID for this election
    con.execute("DROP TABLE IF EXISTS voted_ncids;")
    con.execute(
        """
        CREATE TABLE voted_ncids AS
        SELECT
            county_desc AS voted_county_desc,
            ncid
        FROM (
            SELECT
                county_desc,
                ncid,
                row_number() OVER (PARTITION BY ncid ORDER BY county_desc) AS rn
            FROM ncvhis_election
        )
        WHERE rn = 1
        """
    )

    # -----------------------
    # 3) Attributes: ncvoter (only needed columns)
    # -----------------------
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
            strict_mode=false,
            ignore_errors=true,
            null_padding=true,
            max_line_size=10000000,
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
        WHERE replace(trim(column3), '"', '') IS NOT NULL
        AND length(replace(trim(column3), '"', '')) > 0
        AND lower(replace(trim(column3), '"', '')) != 'ncid'
        """,
        [args.ncvoter],
    )


    # -----------------------
    # 4) Join voted -> ncvoter; log QA
    # -----------------------
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

    print(f"[INFO] election: {election_iso} ({election_mmddyyyy})")
    print(f"[INFO] voted records (deduped ncid): {total_voted:,}")
    print(f"[INFO] join mismatches (dropped): {join_mismatches:,} ({join_mismatch_rate*100:.2f}%)")
    print(f"[INFO] county mismatches (kept, but county uses reg_county): {county_mismatches:,} ({county_mismatch_rate*100:.2f}%)")

    # Save mismatch lists
    mismatch_ncids_path = Path(args.qa_dir) / f"mismatched_ncids_{election_iso}.csv"
    con.execute(
        """
        COPY (
            SELECT ncid, voted_county_desc
            FROM voted_joined
            WHERE reg_county_desc IS NULL
        ) TO ? (HEADER, DELIMITER ',')
        """,
        [str(mismatch_ncids_path)],
    )

    county_mismatch_path = Path(args.qa_dir) / f"county_mismatch_{election_iso}.csv"
    con.execute(
        """
        COPY (
            SELECT ncid, voted_county_desc, reg_county_desc
            FROM voted_joined
            WHERE reg_county_desc IS NOT NULL AND voted_county_desc != reg_county_desc
        ) TO ? (HEADER, DELIMITER ',')
        """,
        [str(county_mismatch_path)],
    )

    qa_summary_path = Path(args.qa_dir) / f"qa_summary_{election_iso}.csv"
    con.execute("DROP TABLE IF EXISTS qa_summary_tmp;")
    con.execute(
        f"""
        CREATE TABLE qa_summary_tmp AS
        SELECT
            '{election_iso}' AS election_date,
            '{election_mmddyyyy}' AS election_lbl,
            {int(total_voted)}::BIGINT AS total_voted_ncids,
            {int(join_mismatches)}::BIGINT AS join_mismatches_dropped,
            {float(join_mismatch_rate)}::DOUBLE AS join_mismatch_rate,
            {int(county_mismatches)}::BIGINT AS county_mismatches_kept,
            {float(county_mismatch_rate)}::DOUBLE AS county_mismatch_rate
        """
    )

    con.execute(
        """
        COPY qa_summary_tmp TO ? (HEADER, DELIMITER ',')
        """,
        [str(qa_summary_path)],
    )
    # -----------------------
    # 5) Clean voted + compute age_group aligned to voter_stats bins
    #    Use reg_county_desc for county bucket.
    # -----------------------
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
    va = con.execute("SELECT COUNT(*) FROM voted_aggregated").fetchone()[0]
    print(f"[CHECK] voted_aggregated rows: {va:,}")

    # how many rows match between denominator and numerator on the full key?
    matches = con.execute("""
    SELECT COUNT(*)
    FROM voter_stats_denominator d
    JOIN voted_aggregated v
    ON d.election_date = v.election_date
    AND d.county_desc = v.county_desc
    AND d.party_cd = v.party_cd
    AND d.race_code = v.race_code
    AND d.ethnic_code = v.ethnic_code
    AND d.sex_code = v.sex_code
    AND d.age_group = v.age_group
    """).fetchone()[0]
    print(f"[CHECK] exact key matches between denominator and voted_aggregated: {matches:,}")

    # -----------------------
    # 6) Join numerator to denominator buckets + export
    # -----------------------
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
            CASE
                WHEN d.registered_count = 0 THEN NULL
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
            FROM turnout_buckets
        ) TO ? (HEADER, DELIMITER ',')
        """,
        [args.out_csv],
    )
    statewide = con.execute("""
    SELECT
    SUM(voted_count) AS voted,
    SUM(registered_count) AS registered,
    SUM(voted_count) * 1.0 / NULLIF(SUM(registered_count), 0) AS turnout
    FROM turnout_buckets
    """).fetchone()

    print(f"[CHECK] statewide voted={statewide[0]:,} registered={statewide[1]:,} turnout={statewide[2]:.4f}")
    
    bad = con.execute("""
    SELECT COUNT(*) FROM turnout_buckets WHERE registered_count = 0
    """).fetchone()[0]
    print(f"[CHECK] buckets with registered_count=0: {bad}")
    
    missing_votes = con.execute("""
    SELECT SUM(v.voted_count) 
    FROM voted_aggregated v
    LEFT JOIN voter_stats_denominator d
    ON d.election_date = v.election_date
    AND d.county_desc = v.county_desc
    AND d.party_cd = v.party_cd
    AND d.race_code = v.race_code
    AND d.ethnic_code = v.ethnic_code
    AND d.sex_code = v.sex_code
    AND d.age_group = v.age_group
    WHERE d.county_desc IS NULL
    """).fetchone()[0]
    print(f"[CHECK] voted_aggregated counts with no denominator match: {missing_votes}")

    print(f"[OK] wrote: {args.out_csv}")
    print(f"[OK] QA: {qa_summary_path}")
    print(f"[OK] mismatched ncids: {mismatch_ncids_path}")
    print(f"[OK] county mismatches: {county_mismatch_path}")
    print(f"[OK] duckdb db: {args.db_path}")


if __name__ == "__main__":
    main()
