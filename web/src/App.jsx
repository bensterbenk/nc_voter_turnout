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

// Continuous color spectrum based on turnout rate
function bucketColor(rate) {
  if (rate == null) return "#cccccc";
  
  // Define color stops (low to high turnout)
  const colors = [
    { rate: 0.0, hex: "#fee5d9" },  // very light peach
    { rate: 0.5, hex: "#fcae91" },  // light orange
    { rate: 0.6, hex: "#fb6a4a" },  // orange
    { rate: 0.7, hex: "#de2d26" },  // red
    { rate: 1.0, hex: "#a50f15" },  // dark red
  ];
  
  // Find surrounding color stops
  let lower = colors[0];
  let upper = colors[colors.length - 1];
  
  for (let i = 0; i < colors.length - 1; i++) {
    if (rate >= colors[i].rate && rate <= colors[i + 1].rate) {
      lower = colors[i];
      upper = colors[i + 1];
      break;
    }
  }
  
  // Interpolate between the two surrounding colors
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
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 0, g: 0, b: 0 };
}

function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map(x => {
    const hex = x.toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  }).join("");
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
