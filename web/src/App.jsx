import { useMemo, useState } from "react";
import { MapContainer, TileLayer, GeoJSON } from "react-leaflet";
import { csvParse } from "d3-dsv";
import L from "leaflet";

import countiesRaw from "./data/nc_counties.geojson?raw";
import turnoutRaw from "./data/county_turnout_2022_2024_general.csv?raw";

function clamp01(x) {
  if (x == null || Number.isNaN(x)) return null;
  return Math.max(0, Math.min(1, x));
}

// Simple bucket palette (you can refine later)
function bucketColor(rate) {
  if (rate == null) return "#cccccc";
  if (rate < 0.50) return "#fee5d9";
  if (rate < 0.60) return "#fcae91";
  if (rate < 0.65) return "#fb6a4a";
  if (rate < 0.70) return "#de2d26";
  return "#a50f15";
}

export default function App() {
  const countyGeo = useMemo(() => JSON.parse(countiesRaw), []);
  const rows = useMemo(() => csvParse(turnoutRaw), []);
  const [mapInstance, setMapInstance] = useState(null);

  // NC bounding box (roughly)
  const ncBounds = L.latLngBounds(
    [33.84, -84.32], // SW corner
    [36.59, -75.40]  // NE corner
  );

  // Elections available in your CSV
  const elections = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      if (r.election_date && r.election_desc) m.set(r.election_date, r.election_desc);
    }
    return Array.from(m.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, desc]) => ({ date, desc }));
  }, [rows]);

  const [selectedElection, setSelectedElection] = useState(elections[0]?.date ?? "2022-11-08");

  // Lookup keyed by `${election_date}|${county_name_uppercase}`
  const turnoutLookup = useMemo(() => {
    const map = new Map();
    for (const r of rows) {
      const key = `${r.election_date}|${r.county_desc.toUpperCase()}`;
      map.set(key, {
        turnout: clamp01(parseFloat(r.turnout_rate)),
        votersVoted: Number.parseInt(r.voters_voted, 10),
        registered: Number.parseInt(r.registered_active, 10),
        electionDesc: r.election_desc,
        countyDesc: r.county_desc,
      });
    }
    return map;
  }, [rows]);

  // Style counties by turnout
  const styleFeature = (feature) => {
    const countyName = feature?.properties?.County; // "Alamance"
    const data = turnoutLookup.get(`${selectedElection}|${countyName.toUpperCase()}`);
    const turnout = data?.turnout ?? null;

    return {
      weight: 1,
      color: "#666",
      fillOpacity: 0.75,
      fillColor: bucketColor(turnout),
    };
  };

  // Tooltip on hover
  const onEachFeature = (feature, layer) => {
    const countyName = feature?.properties?.County; // "Alamance"

    const data = turnoutLookup.get(`${selectedElection}|${countyName.toUpperCase()}`);
    const turnoutText =
      data?.turnout == null ? "No data" : `${(data.turnout * 100).toFixed(1)}%`;

    const extra =
      data?.turnout == null
        ? ""
        : `<br/>Voted: ${data.votersVoted.toLocaleString()}<br/>Active reg: ${data.registered.toLocaleString()}`;

    layer.bindTooltip(
      `<strong>${countyName} County</strong><br/>Turnout: ${turnoutText}${extra}`,
      { sticky: true }
    );
  };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: 8, borderBottom: "1px solid #ddd" }}>
        <label style={{ marginRight: 8 }}>Election:</label>
        <select value={selectedElection} onChange={(e) => setSelectedElection(e.target.value)}>
          {elections.map((e) => (
            <option key={e.date} value={e.date}>
              {e.desc} ({e.date})
            </option>
          ))}
        </select>
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
          ref={setMapInstance}
        >
          <GeoJSON data={countyGeo} style={styleFeature} onEachFeature={onEachFeature} />
        </MapContainer>
      </div>
    </div>
  );
}
