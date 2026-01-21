import os
import duckdb

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

RAW_DIR = os.path.join(REPO_ROOT, "data", "raw")
DB_DIR = os.path.join(REPO_ROOT, "duckdb")
DB_PATH = os.path.join(DB_DIR, "nc_voter.duckdb")

HIS_PATH = os.path.join(RAW_DIR, "ncvhis_Statewide.txt")
VOTER_PATH = os.path.join(RAW_DIR, "ncvoter_Statewide.txt")

os.makedirs(DB_DIR, exist_ok=True)

def main() -> None:
    if not os.path.exists(HIS_PATH):
        raise FileNotFoundError(f"Missing history file: {HIS_PATH}")
    if not os.path.exists(VOTER_PATH):
        raise FileNotFoundError(f"Missing voter file: {VOTER_PATH}")

    con = duckdb.connect(DB_PATH)
    DELIM = "\t"
    
    # Load raw files into "bronze" tables.
    # DuckDB can auto-detect headers & types; delim is tab for NC files.
    con.execute("DROP TABLE IF EXISTS bronze_voter_history;")
    con.execute("""
        CREATE TABLE bronze_voter_history AS
        SELECT *
        FROM read_csv_auto(?, delim=?, header=true, ignore_errors=false);
    """, [HIS_PATH, DELIM])
    
    
    con.execute("DROP TABLE IF EXISTS bronze_voters;")
    con.execute("""
    CREATE TABLE bronze_voters AS
    SELECT *
    FROM read_csv_auto(
        ?,
        delim=?,
        header=true,
        quote='"',
        encoding='CP1252',
        all_varchar=true
    );
""", [VOTER_PATH, DELIM])


    # Quick sanity prints
    history_count = con.execute("SELECT COUNT(*) FROM bronze_voter_history;").fetchone()[0]
    voters_count = con.execute("SELECT COUNT(*) FROM bronze_voters;").fetchone()[0]
    print(f"Loaded bronze_voter_history rows: {history_count:,}")
    print(f"Loaded bronze_voters rows:        {voters_count:,}")

    # Confirm columns exist that you expect to use soon
    cols = con.execute("""
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'bronze_voter_history'
        ORDER BY ordinal_position;
    """).fetchall()
    print("\nFirst 25 columns in bronze_voter_history:")
    for c in cols[:25]:
        print(" -", c[0])

    con.close()
    print(f"\nDuckDB ready at: {DB_PATH}")

if __name__ == "__main__":
    main()
