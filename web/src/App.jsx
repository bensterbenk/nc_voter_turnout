import { useMemo, useState, useEffect } from "react";
import { MapContainer, GeoJSON } from "react-leaflet";
import { csvParse } from "d3-dsv";
import L from "leaflet";

import countiesRaw from "./data/nc_counties.geojson?raw";
import demoRaw from "./data/county_demographic_turnout_all.csv?raw";

function clamp01(x) {
  if (x == null || Number.isNaN(x)) return null;
  return Math.max(0, Math.min(1, x));
}

// --------------------
// Label maps
// --------------------
const PARTY_LABELS = {
  CST: "Constitution",
  DEM: "Democratic",
  GRE: "Green",
  LIB: "Libertarian",
  NLB: "No Labels",
  REP: "Republican",
  UNA: "Unaffiliated",
};

const RACE_LABELS = {
  A: "Asian",
  B: "Black or African American",
  I: "Indian American or Alaska Native",
  M: "Two or More Races",
  O: "Other",
  P: "Native Hawaiian or Pacific Islander",
  U: "Undesignated",
  W: "White",
};

const ETHNICITY_LABELS = {
  HL: "Hispanic or Latino",
  NL: "Not Hispanic or Not Latino",
  UN: "Undesignated",
};

const SEX_LABELS = {
  F: "Female",
  M: "Male",
  U: "Undesignated",
};

const AGE_LABELS = {
  "Age < 18 Or Invalid Birth Dates": "Age < 18 or invalid birth dates",
  "Age 18 - 25": "Age 18–25",
  "Age 26 - 40": "Age 26–40",
  "Age 41 - 65": "Age 41–65",
  "Age Over 66": "Age 66+",
};

function labelFor(code, map) {
  const c = (code || "").trim();
  if (!c || c === "All") return "All";
  return map[c] || c;
}

function uniqSorted(rows, key) {
  return Array.from(new Set(rows.map((r) => (r[key] || "").trim()).filter(Boolean))).sort();
}

// --------------------
// Color ramp (same as before)
// --------------------
function bucketColor(rate01) {
  if (rate01 == null) return "#cccccc";

  const colors = [
    { rate: 0.0, hex: "#fee5d9" },
    { rate: 0.5, hex: "#fcae91" },
    { rate: 0.6, hex: "#fb6a4a" },
    { rate: 0.7, hex: "#de2d26" },
    { rate: 1.0, hex: "#a50f15" },
  ];

  let lower = colors[0];
  let upper = colors[colors.length - 1];

  for (let i = 0; i < colors.length - 1; i++) {
    if (rate01 >= colors[i].rate && rate01 <= colors[i + 1].rate) {
      lower = colors[i];
      upper = colors[i + 1];
      break;
    }
  }

  const t = (rate01 - lower.rate) / (upper.rate - lower.rate);
  const lowerRGB = hexToRgb(lower.hex);
  const upperRGB = hexToRgb(upper.hex);

  const r = Math.round(lowerRGB.r + (upperRGB.r - lowerRGB.r) * t);
  const g = Math.round(lowerRGB.g + (upperRGB.g - lowerRGB.g) * t);
  const b = Math.round(lowerRGB.b + (upperRGB.b - lowerRGB.b) * t);

  return rgbToHex(r, g, b);
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : { r: 0, g: 0, b: 0 };
}

function rgbToHex(r, g, b) {
  return (
    "#" +
    [r, g, b]
      .map((x) => {
        const hex = x.toString(16);
        return hex.length === 1 ? "0" + hex : hex;
      })
      .join("")
  );
}

function fmtPct(x) {
  if (x == null || !Number.isFinite(x)) return "No data";
  return `${(x * 100).toFixed(1)}%`;
}

function Legend({ minPct, maxPct }) {
  // simple 5-stop swatch legend, driven by displayed min/max percent
  const stops = [
    { t: 0.0, label: `${Math.round(minPct)}%` },
    { t: 0.25, label: `${Math.round(minPct + (maxPct - minPct) * 0.25)}%` },
    { t: 0.5, label: `${Math.round(minPct + (maxPct - minPct) * 0.5)}%` },
    { t: 0.75, label: `${Math.round(minPct + (maxPct - minPct) * 0.75)}%` },
    { t: 1.0, label: `${Math.round(maxPct)}%` },
  ];

  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        zIndex: 1000,
        background: "rgba(255,255,255,0.95)",
        border: "1px solid #ddd",
        borderRadius: 8,
        padding: 10,
        minWidth: 170,
        boxShadow: "0 1px 6px rgba(0,0,0,0.08)",
        fontSize: 12,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Turnout (color)</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {stops.map((s) => (
          <div key={s.t} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div
              style={{
                width: 18,
                height: 12,
                borderRadius: 3,
                border: "1px solid rgba(0,0,0,0.15)",
                background: bucketColor(s.t),
              }}
            />
            <div style={{ opacity: 0.9 }}>{s.label}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 8, opacity: 0.7 }}>
        Light ≈ lower turnout, dark ≈ higher turnout
      </div>
    </div>
  );
}

export default function App() {
  const countyGeo = useMemo(() => JSON.parse(countiesRaw), []);
  const demoRows = useMemo(() => csvParse(demoRaw), []);
  const [mapInstance, setMapInstance] = useState(null);

  const ncBounds = useMemo(() => L.latLngBounds([33.84, -84.32], [36.59, -75.40]), []);

  useEffect(() => {
    if (mapInstance) mapInstance.fitBounds(ncBounds);
  }, [mapInstance, ncBounds]);

  // --------------------
  // Election dropdown (from CSV)
  // --------------------
  const elections = useMemo(() => uniqSorted(demoRows, "election_date").sort().reverse(), [demoRows]);

  const [selectedElection, setSelectedElection] = useState(() => elections[0] || "2025-11-04");

  // If the CSV loads and elections become available, ensure we default to newest.
  useEffect(() => {
    if (elections.length && !elections.includes(selectedElection)) {
      setSelectedElection(elections[0]);
    }
  }, [elections, selectedElection]);

  const demoRowsForElection = useMemo(() => {
    return demoRows.filter((r) => (r.election_date || "").trim() === selectedElection);
  }, [demoRows, selectedElection]);

  // Selector options (based on filtered demo rows)
  const parties = useMemo(() => ["All", ...uniqSorted(demoRowsForElection, "party_cd")], [demoRowsForElection]);
  const races = useMemo(() => ["All", ...uniqSorted(demoRowsForElection, "race_code")], [demoRowsForElection]);
  const ethnics = useMemo(() => ["All", ...uniqSorted(demoRowsForElection, "ethnic_code")], [demoRowsForElection]);
  const sexes = useMemo(() => ["All", ...uniqSorted(demoRowsForElection, "sex_code")], [demoRowsForElection]);
  const ages = useMemo(() => ["All", ...uniqSorted(demoRowsForElection, "age_group")], [demoRowsForElection]);

  const [selectedParty, setSelectedParty] = useState("All");
  const [selectedRace, setSelectedRace] = useState("All");
  const [selectedEthnic, setSelectedEthnic] = useState("All");
  const [selectedSex, setSelectedSex] = useState("All");
  const [selectedAge, setSelectedAge] = useState("All");

  // Per-county aggregated counts for selected filters
  const perCountyFiltered = useMemo(() => {
    const map = new Map();

    for (const r of demoRowsForElection) {
      const county = (r.county_desc || "").toUpperCase().trim();
      if (!county) continue;

      if (selectedParty !== "All" && r.party_cd !== selectedParty) continue;
      if (selectedRace !== "All" && r.race_code !== selectedRace) continue;
      if (selectedEthnic !== "All" && r.ethnic_code !== selectedEthnic) continue;
      if (selectedSex !== "All" && r.sex_code !== selectedSex) continue;
      if (selectedAge !== "All" && r.age_group !== selectedAge) continue;

      const reg = Number.parseInt(r.registered_count || "0", 10) || 0;
      const voted = Number.parseInt(r.voted_count || "0", 10) || 0;

      if (!map.has(county)) map.set(county, { registered: 0, voted: 0, turnout: null });
      const cur = map.get(county);
      cur.registered += reg;
      cur.voted += voted;
    }

    for (const v of map.values()) {
      v.turnout = v.registered === 0 ? null : clamp01(v.voted / v.registered);
    }

    return map;
  }, [demoRowsForElection, selectedParty, selectedRace, selectedEthnic, selectedSex, selectedAge]);

  // Statewide rollup for filters
  const statewideFiltered = useMemo(() => {
    let voted = 0;
    let registered = 0;

    for (const v of perCountyFiltered.values()) {
      voted += v.voted || 0;
      registered += v.registered || 0;
    }

    const turnout = registered === 0 ? null : voted / registered;
    return { voted, registered, turnout };
  }, [perCountyFiltered]);

  // --------------------
  // Percentile-based scaling for choropleth contrast
  // (compute lo/hi on per-county turnout and normalize into 0..1)
  // --------------------
  const colorScale = useMemo(() => {
    const vals = [];
    for (const v of perCountyFiltered.values()) {
      if (v.turnout != null && Number.isFinite(v.turnout)) vals.push(v.turnout);
    }
    vals.sort((a, b) => a - b);

    if (vals.length < 5) {
      return { scale: (t) => (t == null ? null : clamp01(t)), lo: 0, hi: 1 };
    }

    const q = (p) => vals[Math.floor(p * (vals.length - 1))];
    const lo = q(0.05); // 5th percentile
    const hi = q(0.95); // 95th percentile

    const scale = (t) => {
      if (t == null || !Number.isFinite(t)) return null;
      if (hi === lo) return 0.5;
      const x = Math.max(lo, Math.min(hi, t));
      return (x - lo) / (hi - lo); // 0..1
    };

    return { scale, lo, hi };
  }, [perCountyFiltered]);

  const styleFeature = (feature) => {
    const key = (feature?.properties?.County || "").toUpperCase();
    const raw = perCountyFiltered.get(key)?.turnout ?? null;
    const scaled01 = colorScale.scale(raw);

    return {
      weight: 1,
      color: "#666",
      fillOpacity: 0.75,
      fillColor: bucketColor(scaled01),
    };
  };

  const onEachFeature = (feature, layer) => {
    const countyName = feature?.properties?.County || "";
    const key = countyName.toUpperCase();
    const f = perCountyFiltered.get(key);

    if (!f) {
      layer.bindTooltip(`<strong>${countyName} County</strong><br/>No data`, { sticky: true });
      return;
    }

    const turnoutText = fmtPct(f.turnout);
    layer.bindTooltip(
      `<strong>${countyName} County</strong><br/>Turnout: ${turnoutText}<br/>Voted: ${f.voted.toLocaleString()}<br/>Registered: ${f.registered.toLocaleString()}`,
      { sticky: true }
    );
  };

  // Legend min/max shown in % based on percentile window (matches color scale)
  const legendMinPct = useMemo(() => {
    if (!Number.isFinite(colorScale.lo)) return 0;
    return Math.max(0, Math.min(100, colorScale.lo * 100));
  }, [colorScale.lo]);

  const legendMaxPct = useMemo(() => {
    if (!Number.isFinite(colorScale.hi)) return 100;
    return Math.max(0, Math.min(100, colorScale.hi * 100));
  }, [colorScale.hi]);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          padding: 8,
          borderBottom: "1px solid #ddd",
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <label>
          <strong>Election:</strong>&nbsp;
          <select value={selectedElection} onChange={(e) => setSelectedElection(e.target.value)}>
            {elections.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>

        <label>
          Party:&nbsp;
          <select value={selectedParty} onChange={(e) => setSelectedParty(e.target.value)}>
            {parties.map((p) => (
              <option key={p} value={p}>
                {labelFor(p, PARTY_LABELS)}
              </option>
            ))}
          </select>
        </label>

        <label>
          Race:&nbsp;
          <select value={selectedRace} onChange={(e) => setSelectedRace(e.target.value)}>
            {races.map((r) => (
              <option key={r} value={r}>
                {labelFor(r, RACE_LABELS)}
              </option>
            ))}
          </select>
        </label>

        <label>
          Ethnicity:&nbsp;
          <select value={selectedEthnic} onChange={(e) => setSelectedEthnic(e.target.value)}>
            {ethnics.map((e) => (
              <option key={e} value={e}>
                {labelFor(e, ETHNICITY_LABELS)}
              </option>
            ))}
          </select>
        </label>

        <label>
          Gender:&nbsp;
          <select value={selectedSex} onChange={(e) => setSelectedSex(e.target.value)}>
            {sexes.map((s) => (
              <option key={s} value={s}>
                {labelFor(s, SEX_LABELS)}
              </option>
            ))}
          </select>
        </label>

        <label>
          Age:&nbsp;
          <select value={selectedAge} onChange={(e) => setSelectedAge(e.target.value)}>
            {ages.map((a) => (
              <option key={a} value={a}>
                {labelFor(a, AGE_LABELS)}
              </option>
            ))}
          </select>
        </label>

        <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.95 }}>
          <strong>Statewide (filters):</strong>&nbsp;
          {fmtPct(statewideFiltered.turnout)}{" "}
          <span style={{ opacity: 0.75 }}>
            (Voted: {statewideFiltered.voted.toLocaleString()} / Registered:{" "}
            {statewideFiltered.registered.toLocaleString()})
          </span>
        </div>
      </div>

      <div style={{ position: "relative", flex: 1 }}>
        {/* Legend top-right */}
        <Legend minPct={legendMinPct} maxPct={legendMaxPct} />

        <MapContainer
          style={{ height: "100%", width: "100%" }}
          center={[35.5, -79.0]}
          zoom={7.2}
          maxBounds={[[33.84, -84.32], [36.59, -75.40]]}
          maxBoundsViscosity={1.0}
          whenCreated={setMapInstance}
        >
          <GeoJSON
            key={`${selectedElection}-${selectedParty}-${selectedRace}-${selectedEthnic}-${selectedSex}-${selectedAge}`}
            data={countyGeo}
            style={styleFeature}
            onEachFeature={onEachFeature}
          />
        </MapContainer>
      </div>
    </div>
  );
}

