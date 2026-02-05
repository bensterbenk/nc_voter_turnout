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
// Selector styles
// --------------------
const controlStyles = {
  wrapper: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    fontSize: 12,
    fontWeight: 600,
    color: "#333",
  },
  select: {
    appearance: "none",
    padding: "6px 28px 6px 10px",
    fontSize: 13,
    borderRadius: 8,
    border: "1px solid #ccc",
    background: "white",
    backgroundImage:
      "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6'><path d='M0 0l5 6 5-6z' fill='%23666'/></svg>\")",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right 10px center",
    cursor: "pointer",
  },
};

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
// Color ramp
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
          <div>{s.label}</div>
        </div>
      ))}
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

  const elections = useMemo(
    () => uniqSorted(demoRows, "election_date").sort().reverse(),
    [demoRows]
  );

  const [selectedElection, setSelectedElection] = useState(() => elections[0] || "");

  useEffect(() => {
    if (elections.length && !elections.includes(selectedElection)) {
      setSelectedElection(elections[0]);
    }
  }, [elections, selectedElection]);

  const demoRowsForElection = useMemo(
    () => demoRows.filter((r) => r.election_date === selectedElection),
    [demoRows, selectedElection]
  );

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

  const perCountyFiltered = useMemo(() => {
    const map = new Map();
    for (const r of demoRowsForElection) {
      const county = (r.county_desc || "").toUpperCase();
      if (!county) continue;
      if (selectedParty !== "All" && r.party_cd !== selectedParty) continue;
      if (selectedRace !== "All" && r.race_code !== selectedRace) continue;
      if (selectedEthnic !== "All" && r.ethnic_code !== selectedEthnic) continue;
      if (selectedSex !== "All" && r.sex_code !== selectedSex) continue;
      if (selectedAge !== "All" && r.age_group !== selectedAge) continue;

      const reg = +r.registered_count || 0;
      const voted = +r.voted_count || 0;

      if (!map.has(county)) map.set(county, { registered: 0, voted: 0 });
      map.get(county).registered += reg;
      map.get(county).voted += voted;
    }

    for (const v of map.values()) {
      v.turnout = v.registered ? clamp01(v.voted / v.registered) : null;
    }

    return map;
  }, [demoRowsForElection, selectedParty, selectedRace, selectedEthnic, selectedSex, selectedAge]);

  const colorScale = useMemo(() => {
    const vals = [...perCountyFiltered.values()]
      .map((v) => v.turnout)
      .filter((v) => v != null)
      .sort((a, b) => a - b);

    if (vals.length < 5) return { scale: (t) => t, lo: 0, hi: 1 };

    const lo = vals[Math.floor(vals.length * 0.05)];
    const hi = vals[Math.floor(vals.length * 0.95)];

    return {
      lo,
      hi,
      scale: (t) => (t == null ? null : (Math.min(hi, Math.max(lo, t)) - lo) / (hi - lo)),
    };
  }, [perCountyFiltered]);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          padding: 12,
          borderBottom: "1px solid #e0e0e0",
          display: "flex",
          gap: 14,
          flexWrap: "wrap",
          alignItems: "flex-end",
          background: "#fafafa",
        }}
      >
        {[
          ["Election", selectedElection, setSelectedElection, elections],
          ["Party", selectedParty, setSelectedParty, parties],
          ["Race", selectedRace, setSelectedRace, races],
          ["Ethnicity", selectedEthnic, setSelectedEthnic, ethnics],
          ["Gender", selectedSex, setSelectedSex, sexes],
          ["Age", selectedAge, setSelectedAge, ages],
        ].map(([label, value, setter, options]) => (
          <div key={label} style={controlStyles.wrapper}>
            <span>{label}</span>
            <select
              style={controlStyles.select}
              value={value}
              onChange={(e) => setter(e.target.value)}
            >
              {options.map((o) => (
                <option key={o} value={o}>
                  {labelFor(o, {
                    ...PARTY_LABELS,
                    ...RACE_LABELS,
                    ...ETHNICITY_LABELS,
                    ...SEX_LABELS,
                    ...AGE_LABELS,
                  })}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div style={{ position: "relative", flex: 1 }}>
        <Legend minPct={colorScale.lo * 100} maxPct={colorScale.hi * 100} />

        <div
          style={{
            position: "absolute",
            bottom: 8,
            left: 10,
            zIndex: 1000,
            fontSize: 11,
            opacity: 0.75,
            background: "rgba(255,255,255,0.85)",
            padding: "4px 8px",
            borderRadius: 6,
            border: "1px solid #ddd",
          }}
        >
          Designed by <strong>Ben Sterbenk</strong>
        </div>

        <MapContainer
          style={{ height: "100%", width: "100%" }}
          center={[35.5, -79]}
          zoom={7.2}
          maxBounds={[[33.84, -84.32], [36.59, -75.40]]}
          whenCreated={setMapInstance}
        >
          <GeoJSON
            data={countyGeo}
            style={(feature) => {
              const key = feature.properties.County.toUpperCase();
              const t = perCountyFiltered.get(key)?.turnout;
              return {
                weight: 1,
                color: "#666",
                fillOpacity: 0.75,
                fillColor: bucketColor(colorScale.scale(t)),
              };
            }}
          />
        </MapContainer>
      </div>
    </div>
  );
}
