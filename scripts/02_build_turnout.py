import os
import duckdb

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DB_PATH = os.path.join(REPO_ROOT, "duckdb", "nc_voter.duckdb")
OUT_DIR = os.path.join(REPO_ROOT, "data", "processed")
OUT_CSV = os.path.join(OUT_DIR, "county_turnout_2022_2024_general.csv")
OUT_PARQUET = os.path.join(OUT_DIR, "county_turnout_2022_2024_general.parquet")


TARGET_ELECTIONS = [
    ("2024-11-05", "11/05/2024 GENERAL"),
    ("2022-11-08", "11/08/2022 GENERAL"),
]

def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)

    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"Missing DuckDB file: {DB_PATH}")

    con = duckdb.connect(DB_PATH)

    # Create a small in-query table of the elections we care about.
    # We'll join against it so we only scan history for those elections.
    con.execute("DROP TABLE IF EXISTS target_elections;")
    con.execute("""
        CREATE TEMP TABLE target_elections (
            election_date DATE,
            election_desc VARCHAR
        );
    """)
    con.executemany(
        "INSERT INTO target_elections VALUES (?, ?);",
        TARGET_ELECTIONS
    )

    # IMPORTANT: bronze_voters was loaded with all_varchar=true, so values are strings.
    # We'll compute:
    #  - registered_active: active registered voters by county
    #  - voters_voted: distinct ncid in history by county+election
    #
    # Then turnout = voters_voted / registered_active.
    con.execute("""
        CREATE OR REPLACE TEMP VIEW registered_active AS
        SELECT
            county_desc,
            lpad(county_id, 3, '0') AS county_fips,
            COUNT(DISTINCT ncid) AS registered_active
        FROM bronze_voters
        WHERE voter_status_desc = 'ACTIVE'
        AND ncid IS NOT NULL
        AND county_desc IS NOT NULL
        AND county_id IS NOT NULL
        GROUP BY county_desc, county_fips;
    """)

    con.execute("""
        CREATE OR REPLACE TEMP VIEW voted_by_county AS
        SELECT
            h.county_desc,
            lpad(CAST(h.county_id AS VARCHAR), 3, '0') AS county_fips,
            h.election_lbl AS election_date,
            h.election_desc,
            COUNT(DISTINCT h.ncid) AS voters_voted
        FROM bronze_voter_history h
        JOIN target_elections t
        ON h.election_lbl = t.election_date
        AND h.election_desc = t.election_desc
        WHERE h.ncid IS NOT NULL
        AND h.county_desc IS NOT NULL
        AND h.county_id IS NOT NULL
        GROUP BY h.county_desc, county_fips, h.election_lbl, h.election_desc;
    """)

    con.execute("""
        CREATE OR REPLACE TEMP VIEW turnout AS
        SELECT
            v.county_desc,
            v.county_fips,
            v.election_date,
            v.election_desc,
            v.voters_voted,
            r.registered_active,
            CASE
                WHEN r.registered_active = 0 OR r.registered_active IS NULL THEN NULL
                ELSE (v.voters_voted * 1.0) / r.registered_active
            END AS turnout_rate
        FROM voted_by_county v
        LEFT JOIN registered_active r
        ON v.county_fips = r.county_fips;
    """)

    # Export CSV
    con.execute("""
        COPY (
            SELECT *
            FROM turnout
            ORDER BY election_date, county_desc
        )
        TO ?
        (HEADER, DELIMITER ',');
    """, [OUT_CSV])

    # Export Parquet (handy for web + fast)
    con.execute("""
        COPY (
            SELECT *
            FROM turnout
            ORDER BY election_date, county_desc
        )
        TO ?
        (FORMAT PARQUET);
    """, [OUT_PARQUET])

    # Sanity prints
    n_rows = con.execute("SELECT COUNT(*) FROM turnout;").fetchone()[0]
    con.close()

    print(f"Wrote {n_rows:,} rows to:")
    print(f" - {OUT_CSV}")
    print(f" - {OUT_PARQUET}")


if __name__ == "__main__":
    main()
