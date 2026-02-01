import { useMemo, useState, useEffect } from "react";
import { MapContainer, GeoJSON } from "react-leaflet";
import { csvParse } from "d3-dsv";
import L from "leaflet";

import countiesRaw from "./data/nc_counties.geojson?raw";
import demoRaw from "./data/county_demographic_turnout_20251104.csv?raw";

function clamp01(x) {
  if (x == null || Number.isNaN(x)) return null;
  return Math.max(0, Math.min(1, x));
}

// Continuous color spectrum based on turnout rate
function bucketColor(rate) {
  if (rate == null) return "#cccccc";

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
    if (rate >= colors[i].rate && rate <= colors[i + 1].rate) {
      lower = colors[i];
      upper = colors[i + 1];
      break;
    }
  }

  const t = (rate - lower.rate) / (upper.rate - lower.rate);
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

function uniqSorted(rows, key) {
  return Array.from(new Set(rows.map((r) => (r[key] || "").trim()).filter(Boolean))).sort();
}

export default function App() {
  const countyGeo = useMemo(() => JSON.parse(countiesRaw), []);
  const demoRows = useMemo(() => csvParse(demoRaw), []);

  const [mapInstance, setMapInstance] = useState(null);

  // NC bounding box (roughly)
  const ncBounds = useMemo(() => L.latLngBounds([33.84, -84.32], [36.59, -75.40]), []);

  useEffect(() => {
    if (mapInstance) mapInstance.fitBounds(ncBounds);
  }, [mapInstance, ncBounds]);

  // Election fixed for now
  const selectedElection = "2025-11-04";

  // Only build selector options from the election we’re displaying
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

      if (selectedParty !== "All" && (r.party_cd || "") !== selectedParty) continue;
      if (selectedRace !== "All" && (r.race_code || "") !== selectedRace) continue;
      if (selectedEthnic !== "All" && (r.ethnic_code || "") !== selectedEthnic) continue;
      if (selectedSex !== "All" && (r.sex_code || "") !== selectedSex) continue;
      if (selectedAge !== "All" && (r.age_group || "") !== selectedAge) continue;

      const reg = Number.parseInt(r.registered_count || "0", 10) || 0;
      const voted = Number.parseInt(r.voted_count || "0", 10) || 0;

      if (!map.has(county)) map.set(county, { registered: 0, voted: 0 });
      const cur = map.get(county);
      cur.registered += reg;
      cur.voted += voted;
    }

    // compute turnout
    for (const v of map.values()) {
      v.turnout = v.registered === 0 ? null : clamp01(v.voted / v.registered);
    }

    return map;
  }, [demoRowsForElection, selectedParty, selectedRace, selectedEthnic, selectedSex, selectedAge]);

  // Style counties by turnout
  const styleFeature = (feature) => {
    const countyName = feature?.properties?.County; // "Alamance"
    const key = (countyName || "").toUpperCase();

    const filtered = perCountyFiltered.get(key);
    const turnout = filtered?.turnout ?? null;

    return {
      weight: 1,
      color: "#666",
      fillOpacity: 0.75,
      fillColor: bucketColor(turnout),
    };
  };

  // Tooltip on hover
  const onEachFeature = (feature, layer) => {
    const countyName = feature?.properties?.County;
    const key = (countyName || "").toUpperCase();

    const f = perCountyFiltered.get(key);

    if (!f) {
      layer.bindTooltip(`<strong>${countyName} County</strong><br/>No data`, { sticky: true });
      return;
    }

    const turnoutText = f.turnout == null ? "No data" : `${(f.turnout * 100).toFixed(1)}%`;
    const extra =
      f.turnout == null
        ? ""
        : `<br/>Voted: ${f.voted.toLocaleString()}<br/>Registered: ${f.registered.toLocaleString()}`;

    layer.bindTooltip(`<strong>${countyName} County</strong><br/>Turnout: ${turnoutText}${extra}`, {
      sticky: true,
    });
  };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          padding: 8,
          borderBottom: "1px solid #ddd",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <strong>Election:</strong> 2025-11-04
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label>Party:</label>
          <select value={selectedParty} onChange={(e) => setSelectedParty(e.target.value)}>
            {parties.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label>Race:</label>
          <select value={selectedRace} onChange={(e) => setSelectedRace(e.target.value)}>
            {races.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label>Ethnicity:</label>
          <select value={selectedEthnic} onChange={(e) => setSelectedEthnic(e.target.value)}>
            {ethnics.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label>Gender:</label>
          <select value={selectedSex} onChange={(e) => setSelectedSex(e.target.value)}>
            {sexes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label>Age:</label>
          <select value={selectedAge} onChange={(e) => setSelectedAge(e.target.value)}>
            {ages.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.8 }}>
          Turnout = voted / registered (all registered at election time)
        </div>
      </div>

      <div style={{ flex: 1 }}>
        <MapContainer
          center={[35.5, -79.0]}
          zoom={7.2}
          style={{ height: "100%", width: "100%", backgroundColor: "#f0f0f0" }}
          dragging={true}
          scrollWheelZoom={true}
          doubleClickZoom={true}
          zoomControl={true}
          touchZoom={true}
          maxBounds={[[33.84, -84.32], [36.59, -75.40]]}
          maxBoundsViscosity={1.0}
          whenCreated={setMapInstance}
        >
          <GeoJSON
            key={`${selectedParty}-${selectedRace}-${selectedEthnic}-${selectedSex}-${selectedAge}`}
            data={countyGeo}
            style={styleFeature}
            onEachFeature={onEachFeature}
          />
        </MapContainer>
      </div>
    </div>
  );
}
