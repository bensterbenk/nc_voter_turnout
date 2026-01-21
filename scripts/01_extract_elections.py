# scripts/01_extract_elections.py
import os
import duckdb

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DB_PATH = os.path.join(REPO_ROOT, "duckdb", "nc_voter.duckdb")
OUT_DIR = os.path.join(REPO_ROOT, "data", "processed")
OUT_PATH = os.path.join(OUT_DIR, "elections.csv")


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)

    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"Missing DuckDB file: {DB_PATH}")

    con = duckdb.connect(DB_PATH)

    # Build a distinct list of elections.
    # - election_lbl in your file is a date string like "11/03/2020"
    # - election_desc is the human label like "11/03/2020 GENERAL"
    #
    # try_strptime returns NULL instead of error if anything unexpected appears.
    con.execute("""
    CREATE OR REPLACE TEMP VIEW elections_distinct AS
    SELECT
        election_lbl AS election_date,
        election_desc
    FROM bronze_voter_history
    WHERE election_lbl IS NOT NULL
      AND election_desc IS NOT NULL
    GROUP BY election_lbl, election_desc;
""")


    # Export to CSV (ordered chronologically, then by description).
    con.execute("""
    COPY (
        SELECT
            election_date,
            election_desc
        FROM elections_distinct
        ORDER BY election_date, election_desc
    )
    TO ?
    (HEADER, DELIMITER ',');
""", [OUT_PATH])


    # Quick sanity print
    n = con.execute("SELECT COUNT(*) FROM elections_distinct;").fetchone()[0]
    con.close()

    print(f"Wrote {n:,} unique elections to: {OUT_PATH}")


if __name__ == "__main__":
    main()
