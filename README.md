# NC Voter Turnout 🗳️

This repository builds county-level demographic turnout tables for North Carolina from publicly available voter data provided by the North Carolina State Board of Elections. It also includes a small React/Vite web app that visualizes turnout by county and allows filtering by demographic characteristics.

The project uses a combination of:
- statewide voter history statistics (counts of voters who participated in each election), and
- historical voter registration statistics (counts of registered voters at the time of each election).

Together, these datasets make it possible to calculate realistic historical turnout rates by race, ethnicity, gender, age group, and party registration—defined as the share of registered voters who participated in a given election.

---

## Quickstart ✅

Prerequisites:

- Python 3.9+ with the `duckdb` package (pip install duckdb)
- Node 18+ and npm (or yarn) for the web app

Build turnout for a single election (example):

```bash
python scripts/build_demographic_turnout.py --election_mmddyyyy 11/04/2025
```

Build combined CSV across all `data/raw/voter_stats/*.txt` files:

```bash
python scripts/build_demographic_turnout_all.py
```

Run the web app:

```bash
cd web
npm install
npm run dev
```

---

## Project layout 🔧

- `data/raw/` - raw input files (NC VHIS, NC Voter, voter stats by demographic)
  - `ncvhis/` and `ncvoter/` are expected subfolders
  - `voter_stats/` should contain files named like `voter_stats_YYYYMMDD.txt`
- `data/derived/` - outputs and intermediate DuckDB database (`nc_turnout.duckdb`) and QA CSVs
- `scripts/` - data-processing scripts:
  - `build_demographic_turnout.py` — builds turnout CSV for one election and writes QA files
  - `build_demographic_turnout_all.py` — builds a combined CSV across all `voter_stats` files
- `web/` - React + Vite frontend
  - `web/src/data/` contains the generated CSVs used by the UI

raw data was retrieved from North Carolina State Board of Elections through these two public datasets:

https://www.ncsbe.gov/results-data/voter-history-data
https://www.ncsbe.gov/results-data/voter-registration-data

---


