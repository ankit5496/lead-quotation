import { useState, useEffect } from "react";

// ─── ENV ─────────────────────────────────────────────────────────────────────
const ENV = {
  API_TOKEN:               process.env.REACT_APP_MONDAY_API_TOKEN,
  LEADS_BOARD_ID:          process.env.REACT_APP_LEADS_BOARD_ID,
  BUYER_SUPPLIER_BOARD_ID: process.env.REACT_APP_BUYER_SUPPLIER_BOARD_ID,
  COUNT_BOARD_ID:          process.env.REACT_APP_COUNT_BOARD_ID,
};

// ─── Monday GraphQL core ──────────────────────────────────────────────────────
async function mondayQuery(query, variables = {}) {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "API-Version":   "2024-01",
      "Authorization": ENV.API_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) console.error("[Monday]", json.errors);
  // Return data directly (mirrors the helper signature from your snippet)
  return json?.data || null;
}

// ─── Column ID utility (from your snippet) ───────────────────────────────────
const _columnCache = {}; // { boardId: [ { id, title, type } ] }

async function getColumnId(boardId, columnTitle) {
  if (!_columnCache[boardId]) {
    const data = await mondayQuery(
      `query ($boardId: ID!) {
        boards(ids: [$boardId]) {
          columns { id title type }
        }
      }`,
      { boardId: String(boardId) }
    );

    console.log("[getColumnId] boards response:", JSON.stringify(data?.boards)?.slice(0, 200));
    if (!data?.boards?.[0]) {
      throw new Error(
        `Board ${boardId} not found or not accessible. ` +
        `Check VITE_COUNT_BOARD_ID and that your token has boards:read permission.`
      );
    }
    _columnCache[boardId] = data.boards[0].columns;
    console.log(`[getColumnId] cached ${_columnCache[boardId].length} columns for board ${boardId}`);
  }

  const match = _columnCache[boardId].find(
    (col) => col.title.toLowerCase() === columnTitle.toLowerCase().trim()
  );

  if (!match) {
    console.warn(`[getColumnId] "${columnTitle}" not found on board ${boardId}`);
    return null;
  }

  return match.id;
}

// ─── Fetch leads ──────────────────────────────────────────────────────────────
async function fetchLeads() {
  const data = await mondayQuery(`{
    boards(ids: [${ENV.LEADS_BOARD_ID}]) {
      items_page(limit: 200) { items { id name } }
    }
  }`);
  return data?.boards?.[0]?.items_page?.items || [];
}

// ─── Fetch count items — uses getColumnId to find "Thread Count" col ─────────
async function fetchCountItems() {
  // 1. Resolve the "Thread Count" column ID dynamically
  const threadCountColId = await getColumnId(ENV.COUNT_BOARD_ID, "Thread Count");
  console.log("[fetchCountItems] Thread Count col id:", threadCountColId);

  // 2. Fetch all items; if we have the col id, fetch only that column value
  const colFilter = threadCountColId
    ? `column_values(ids: ["${threadCountColId}"]) { id text value }`
    : `column_values { id text value type }`;

  const data = await mondayQuery(`{
    boards(ids: [${ENV.COUNT_BOARD_ID}]) {
      items_page(limit: 200) {
        items {
          id
          name
          ${colFilter}
        }
      }
    }
  }`);

  const items = data?.boards?.[0]?.items_page?.items || [];

  return items.map((item) => {
    const cv = item.column_values?.[0];
    const raw = cv?.text?.trim() || "";
    // Thread Count stores a plain number e.g. "20" — append "s" → "20s"
    // If it already ends with "s" (e.g. already formatted), keep as-is
    const label = raw
      ? raw.endsWith("s") ? raw : `${raw}s`
      : item.name;
    console.log(`[fetchCountItems] item "${item.name}" raw="${raw}" label="${label}"`);
    return { id: item.id, name: item.name, label };
  });
}

// ─── Fetch suppliers for a given count item ID ────────────────────────────────
// Uses BoardRelationValue inline fragment to get linked_items directly —
// no JSON parsing needed. Paginates until all items are fetched.
// Filters:
//   1. "Counts" connect col must include countItemId in linked_items
//   2. "Type" col text must equal "Supplier" (case-insensitive)
async function fetchSuppliersByCountId(countItemId) {
  if (!countItemId) return [];

  console.log("[fetchSuppliers] searching for countItemId:", countItemId);

  // Resolve column IDs for "Counts" and "Type" by title
  const [countsColId, typeColId] = await Promise.all([
    getColumnId(ENV.BUYER_SUPPLIER_BOARD_ID, "Counts"),
    getColumnId(ENV.BUYER_SUPPLIER_BOARD_ID, "Type"),
  ]);

  console.log("[fetchSuppliers] Counts col id:", countsColId, "| Type col id:", typeColId);

  if (!countsColId) {
    console.error('[fetchSuppliers] "Counts" column not found — check column title on Buyer/Supplier board');
    return [];
  }
  if (!typeColId) {
    console.error('[fetchSuppliers] "Type" column not found — check column title on Buyer/Supplier board');
    return [];
  }

  // Paginate through all items using cursor
  let allItems = [];
  let cursor = null;

  do {
    const data = await mondayQuery(
      `query ($boardId: ID!, $cursor: String) {
        boards(ids: [$boardId]) {
          items_page(limit: 50, cursor: $cursor) {
            cursor
            items {
              id
              name
              column_values(ids: ["${countsColId}", "${typeColId}"]) {
                id
                text
                value
                ... on BoardRelationValue { linked_items { id name } }
                ... on MirrorValue { display_value }
              }
            }
          }
        }
      }`,
      { boardId: String(ENV.BUYER_SUPPLIER_BOARD_ID), cursor }
    );

    const page = data?.boards?.[0]?.items_page;
    const items = page?.items || [];
    allItems = allItems.concat(items);
    cursor = page?.cursor || null;

    console.log(`[fetchSuppliers] fetched ${items.length} items, cursor: ${cursor}`);
  } while (cursor);

  console.log(`[fetchSuppliers] total items on board: ${allItems.length}`);

  // Log first item's column values to verify shape
  if (allItems[0]) {
    console.log("[fetchSuppliers] sample column_values:", JSON.stringify(allItems[0].column_values, null, 2));
  }

  const results = [];

  for (const item of allItems) {
    const countsCV = item.column_values.find((cv) => cv.id === countsColId);
    const typeCV   = item.column_values.find((cv) => cv.id === typeColId);

    const typeText = typeCV?.text?.trim().toLowerCase() || "";

    console.log(
      `[fetchSuppliers] "${item.name}" | Type="${typeCV?.text}" | Counts linked_items=${JSON.stringify(countsCV?.linked_items)}`
    );

    // Filter 1: must be Type = Supplier
    if (typeText !== "supplier") continue;

    // Filter 2: Counts connect col must link to our countItemId
    // Use linked_items from BoardRelationValue inline fragment
    const linkedItems = countsCV?.linked_items || [];
    const linkedIds   = linkedItems.map((li) => String(li.id));

    console.log(`[fetchSuppliers] "${item.name}" linked count IDs:`, linkedIds, "| looking for:", String(countItemId));

    if (!linkedIds.includes(String(countItemId))) continue;

    console.log(`[fetchSuppliers] ✓ MATCHED: "${item.name}"`);
    results.push({ id: item.id, name: item.name });
  }

  console.log(`[fetchSuppliers] found ${results.length} supplier(s) for count ID ${countItemId}`);
  return results;
}

// ─── Resolve subitem column IDs (Count, Suppliers, Rate) ─────────────────────
// We fetch columns from the subitem board of the first item on the lead board.
// Subitem columns are resolved once and cached.
let _subitemColCache = null;
async function getSubitemColIds(leadItemId) {
  if (_subitemColCache) return _subitemColCache;
  const data = await mondayQuery(`{
    boards(ids: [${ENV.LEADS_BOARD_ID}]) {
      items_page(limit: 1) {
        items {
          subitems { id board { id columns { id title type } } }
        }
      }
    }
  }`);
  const subBoard = data?.boards?.[0]?.items_page?.items?.[0]?.subitems?.[0]?.board;
  if (!subBoard) {
    console.warn("[getSubitemColIds] No subitems found — run with an existing subitem or hardcode col IDs");
    return {};
  }
  const cols = subBoard.columns || [];
  console.log("[getSubitemColIds] subitem columns:", cols.map(c => `${c.title}(${c.id}:${c.type})`));
  const find = (title) => cols.find(c => c.title.toLowerCase().trim() === title.toLowerCase().trim())?.id || null;
  _subitemColCache = {
    countColId:    find("Count"),
    supplierColId: find("Suppliers"),
    rateColId:     find("Rate"),
  };
  console.log("[getSubitemColIds] resolved:", _subitemColCache);
  return _subitemColCache;
}

// ─── Create subitems with column values mapped ────────────────────────────────
// Columns on subitem board:
//   Count     → text column  (thread count label e.g. "20s")
//   Suppliers → connect board column (linked to buyer/supplier board by item id)
//   Rate      → text/numbers column
async function createSubitems(leadItemId, rows) {
  const { countColId, supplierColId, rateColId } = await getSubitemColIds(leadItemId);

  // Create subitems one by one (Monday API doesn't support batching column_values on create_subitem reliably)
  const createdIds = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const itemName = `${r.countLabel || r.count} - ${r.supplierName || r.supplier}`.replace(/"/g, "'");

    // Build column_values JSON for the subitem
    const colVals = {};
    if (countColId)    colVals[countColId]    = r.countLabel || r.count;
    if (rateColId)     colVals[rateColId]     = r.rate;
    // Supplier connect board column expects { item_ids: [id] }
    if (supplierColId) colVals[supplierColId] = { item_ids: [parseInt(r.supplier)] };

    const colValsStr = JSON.stringify(JSON.stringify(colVals));

    const res = await mondayQuery(`mutation {
      create_subitem(
        parent_item_id: ${leadItemId},
        item_name: "${itemName}",
        column_values: ${colValsStr}
      ) { id name }
    }`);
    const created = res?.create_subitem;
    console.log(`[createSubitems] created subitem ${i + 1}:`, created);
    if (created?.id) createdIds.push(created.id);
  }
  return createdIds;
}

// ─── Generate PDF using jsPDF (client-side, no CORS) ─────────────────────────
// Requires: npm install jspdf
// Import at top of file: import jsPDF from 'jspdf'
// We load it dynamically so the rest of the app still works without it.
async function loadJsPDF() {
  if (window._jsPDF) return window._jsPDF;
  // Dynamic import — jsPDF must be installed: npm install jspdf
  const mod = await import("jspdf");
  window._jsPDF = mod.default || mod.jsPDF;
  return window._jsPDF;
}

async function generatePdfBlob(rows, leadName) {
  const JsPDF = await loadJsPDF();
  const doc   = new JsPDF({ unit: "pt", format: "a4" });

  const now      = new Date();
  const date     = now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const time     = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
  const datetime = `${date}  ${time}`;

  const PW = 595, PH = 842;
  const ML = 40, MR = 40;
  let y = 30;

  // ── LETTERHEAD ────────────────────────────────────────────────────────────
  // Company name — left
  doc.setFont("helvetica", "normal"); 
  doc.setFontSize(20);
  doc.setTextColor(0, 0, 0);
  doc.text("KAARTHIKA AGENCY", ML, y + 10);

  // Right address block
  const rightX = 360;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(30, 30, 30);
  doc.text("234 Union Mill Road",                       rightX, y);
  doc.text("PAN NO. AHFPS5121G",                        rightX, y + 12);
  doc.text("MOBILE NO. 9487411111",                     rightX, y + 24);
  doc.text("Phone No  :  2201147, 2201138, 2201139",    rightX, y + 40);
  doc.text("Fax No      :  0421-2202245",               rightX, y + 52);
  doc.text("kaarthikaagency@gmail.com",                 rightX, y + 64);
  y += 84;

  // ── Single thick rule under letterhead ───────────────────────────────────
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.8);
  doc.line(ML, y, PW - MR, y);
  y += 16;

  // ── QUOTATION title — left aligned, with margin ───────────────────────────
  y += 8;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(0, 0, 0);
  doc.text("QUOTATION", ML, y);
  y += 28;

  // ── Meta row: Customer/Buyer + Date & Time ────────────────────────────────
  // label row
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(120, 120, 120);
  doc.text("CUSTOMER / BUYER", ML, y);
  doc.text("DATE & TIME", 340, y);
  y += 13;

  // value row
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(0, 0, 0);
  doc.text(leadName, ML, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(datetime, 340, y);
  y += 20;

  y += 6;

  // ── Table ─────────────────────────────────────────────────────────────────
  const cols = [
    { label: "S.NO",          x: ML,       w: 36  },
    { label: "THREAD COUNT",  x: ML + 36,  w: 110 },
    { label: "SUPPLIER",      x: ML + 146, w: 255 },
    { label: "RATE",          x: ML + 401, w: 114 },
  ];
  const tableRight = PW - MR;
  const rowH = 24;

  // Header row — full border including top
  doc.setFillColor(220, 220, 220);
  doc.rect(ML, y - 14, tableRight - ML, rowH, "F");
  doc.setDrawColor(160, 160, 160);
  doc.setLineWidth(0.5);
  doc.rect(ML, y - 14, tableRight - ML, rowH, "S");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(0, 0, 0);
  cols.forEach(c => doc.text(c.label, c.x + c.w / 2, y + 2, { align: "center" }));

  // Vertical dividers in header
  let dvX = ML;
  cols.forEach((c, i) => {
    dvX += c.w;
    if (i < cols.length - 1) {
      doc.setDrawColor(160, 160, 160);
      doc.setLineWidth(0.4);
      doc.line(dvX, y - 14, dvX, y + rowH - 14);
    }
  });
  y += rowH - 2;

  // Data rows
  rows.forEach((r, i) => {
    const rowY = y - 14;

    if (i % 2 === 1) {
      doc.setFillColor(248, 248, 248);
      doc.rect(ML, rowY, tableRight - ML, rowH, "F");
    }

    doc.setDrawColor(210, 210, 210);
    doc.setLineWidth(0.3);
    doc.rect(ML, rowY, tableRight - ML, rowH, "S");

    // vertical col dividers
    let dx = ML;
    cols.forEach((c, ci) => {
      dx += c.w;
      if (ci < cols.length - 1) {
        doc.setDrawColor(210, 210, 210);
        doc.setLineWidth(0.3);
        doc.line(dx, rowY, dx, rowY + rowH);
      }
    });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(0, 0, 0);
    doc.text(String(i + 1),                        cols[0].x + cols[0].w / 2, y + 2, { align: "center" });
    doc.text(r.countLabel   || r.count   || "-",   cols[1].x + cols[1].w / 2, y + 2, { align: "center" });
    doc.text(r.supplierName || r.supplier || "-",   cols[2].x + cols[2].w / 2, y + 2, { align: "center" });
    doc.text(String(r.rate),                        cols[3].x + cols[3].w / 2, y + 2, { align: "center" });
    y += rowH;
  });

  y += 16;

  // ── Footer double rule ────────────────────────────────────────────────────
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.4);
  doc.line(ML, PH - 42, PW - MR, PH - 42);
  doc.setLineWidth(1.5);
  doc.line(ML, PH - 37, PW - MR, PH - 37);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(130, 130, 130);
  doc.text("This is a computer generated quotation.", PW / 2, PH - 24, { align: "center" });

  return doc.output("blob");
}

// ─── Upload PDF blob to Monday Documents column ───────────────────────────────
// Uses setupProxy.js to forward /monday-file → https://api.monday.com (bypasses CORS)
// Run: npm install http-proxy-middleware  and place setupProxy.js in src/
async function uploadPdfToMonday(leadItemId, pdfBlob, fileName) {
  const docsColId = await getColumnId(ENV.LEADS_BOARD_ID, "Documents");
  console.log("[uploadPdf] Documents col id:", docsColId);
  if (!docsColId) {
    console.error('[uploadPdf] "Documents" column not found on Leads board');
    return null;
  }

  const mutation = `mutation ($file: File!) {
    add_file_to_column(item_id: ${leadItemId}, column_id: "${docsColId}", file: $file) { id }
  }`;

  const formData = new FormData();
  formData.append("query", mutation);
  formData.append("variables[file]", pdfBlob, fileName);

  const res = await fetch("/monday-file/v2/file",", {
    method: "POST",
    headers: {
      "Authorization": ENV.API_TOKEN,
      "API-Version":   "2024-01",
    },
    body: formData,
  });

  const json = await res.json();
  if (json.errors) console.error("[uploadPdf] errors:", json.errors);
  console.log("[uploadPdf] result:", json?.data?.add_file_to_column);
  return json?.data?.add_file_to_column?.id || null;
}

async function createAndUploadPdf(leadItemId, rows, leadName) {
  const pdfBlob = await generatePdfBlob(rows, leadName);
  const fileName = `Quotation_${leadName.replace(/[^a-z0-9]/gi, "_")}_${Date.now()}.pdf`;
  console.log("[createPdf] blob size:", pdfBlob.size, "uploading as:", fileName);
  return uploadPdfToMonday(leadItemId, pdfBlob, fileName);
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --black:      #111111;
    --gray-dk:    #444444;
    --gray-md:    #888888;
    --gray-lt:    #bbbbbb;
    --gray-pale:  #e5e5e5;
    --bg:         #f4f4f5;
    --white:      #ffffff;
    --danger:     #dc2626;
    --success:    #16a34a;
    --border:     #e5e5e5;
    --radius:     8px;
    --font:       'Inter', system-ui, -apple-system, sans-serif;
  }

  html, body {
    background: var(--bg);
    font-family: var(--font);
    color: var(--black);
    -webkit-font-smoothing: antialiased;
  }

  .app {
    min-height: 100vh;
    background: var(--bg);
    padding: 24px 20px 60px;
  }

  /* ── Page wrapper ── */
  .page {
    max-width: 900px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  /* ── Card (shared by all sections including header) ── */
  .card {
    background: var(--white);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  /* ── Header card: title left, buttons right ── */
  .header-card {
    padding: 16px 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  .header-left {}

  .header-title {
    font-size: 18px;
    font-weight: 700;
    color: var(--black);
    letter-spacing: -0.02em;
    line-height: 1.2;
  }

  .header-sub {
    font-size: 12px;
    color: var(--gray-md);
    font-weight: 400;
    margin-top: 2px;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  /* ── Buttons ── */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border-radius: 6px;
    font-family: var(--font);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    border: 1.5px solid transparent;
    white-space: nowrap;
  }

  .btn-outline {
    background: var(--white);
    border-color: var(--border);
    color: var(--black);
  }
  .btn-outline:hover:not(:disabled) {
    border-color: var(--black);
    background: var(--bg);
  }

  .btn-primary {
    background: var(--black);
    border-color: var(--black);
    color: var(--white);
  }
  .btn-primary:hover:not(:disabled) {
    background: #333;
    border-color: #333;
  }

  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ── Section head ── */
  .section-head {
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--white);
  }

  .section-num {
    width: 22px;
    height: 22px;
    background: var(--black);
    color: var(--white);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
    flex-shrink: 0;
  }

  .section-head h2 {
    font-size: 13px;
    font-weight: 600;
    color: var(--black);
    letter-spacing: -0.01em;
  }

  .section-body {
    padding: 18px 20px;
  }

  /* ── Form fields ── */
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .field label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--gray-md);
  }

  .sel-wrap { position: relative; }
  .sel-wrap::after {
    content: '';
    position: absolute;
    right: 11px;
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
    border-left: 4px solid transparent;
    border-right: 4px solid transparent;
    border-top: 5px solid var(--gray-dk);
  }

  select, input[type="text"] {
    width: 100%;
    padding: 9px 12px;
    border: 1.5px solid var(--border);
    border-radius: 6px;
    font-family: var(--font);
    font-size: 13px;
    color: var(--black);
    background: var(--white);
    outline: none;
    appearance: none;
    -webkit-appearance: none;
    transition: border-color 0.14s, box-shadow 0.14s;
  }

  select:focus, input:focus {
    border-color: var(--black);
    box-shadow: 0 0 0 3px rgba(17,17,17,0.07);
  }

  select:disabled, input:disabled {
    background: var(--bg);
    color: var(--gray-lt);
    cursor: not-allowed;
  }

  /* ── Row grid ── */
  .rows-head {
    display: grid;
    grid-template-columns: 1fr 1fr 120px 32px;
    gap: 10px;
    padding-bottom: 10px;
    margin-bottom: 2px;
    border-bottom: 1px solid var(--border);
  }
  .rows-head span {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--gray-md);
  }

  .row {
    display: grid;
    grid-template-columns: 1fr 1fr 120px 32px;
    gap: 10px;
    align-items: end;
    padding: 10px 0;
    border-bottom: 1px solid var(--bg);
    animation: fadeIn 0.18s ease;
  }
  .row:last-of-type { border-bottom: none; }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .btn-rm {
    width: 32px;
    height: 36px;
    border: 1.5px solid var(--border);
    border-radius: 6px;
    background: var(--white);
    color: var(--gray-md);
    font-size: 14px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.13s;
    flex-shrink: 0;
  }
  .btn-rm:hover { background: #fef2f2; border-color: var(--danger); color: var(--danger); }

  /* ── Add row ── */
  .btn-add-row {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    background: var(--bg);
    border: 1.5px dashed var(--gray-lt);
    border-radius: 6px;
    color: var(--gray-dk);
    font-family: var(--font);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.14s;
    margin-top: 12px;
  }
  .btn-add-row:hover { border-color: var(--black); color: var(--black); background: #ebebeb; }

  /* ── Empty state ── */
  .empty {
    text-align: center;
    padding: 28px;
    color: var(--gray-md);
    font-size: 13px;
    border: 1.5px dashed var(--border);
    border-radius: 6px;
  }

  /* ── Preview table ── */
  .preview-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--gray-md);
    margin: 20px 0 10px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }

  table.ptable {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
  }
  table.ptable th {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--gray-md);
    padding: 8px 12px;
    text-align: left;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
  }
  table.ptable td {
    padding: 9px 12px;
    border-bottom: 1px solid var(--bg);
    color: var(--black);
    font-size: 13px;
  }
  table.ptable tr:last-child td { border-bottom: none; }

  .tag {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11.5px;
    font-weight: 600;
  }
  .tc { background: var(--black); color: var(--white); }
  .ts { background: var(--bg); color: var(--gray-dk); border: 1px solid var(--border); }

  /* ── Spinner ── */
  .spin {
    width: 12px; height: 12px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: rot 0.55s linear infinite;
    display: inline-block;
    flex-shrink: 0;
  }
  @keyframes rot { to { transform: rotate(360deg); } }

  .load-row {
    display: flex; align-items: center; gap: 8px;
    color: var(--gray-md); font-size: 13px;
  }

  /* ── Status pill ── */
  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 7px 12px;
    border-radius: 6px;
    font-size: 12.5px;
    font-weight: 500;
    border: 1.5px solid;
  }
  .pill-ok  { background: #f0fdf4; color: var(--success); border-color: #bbf7d0; }
  .pill-err { background: #fef2f2; color: var(--danger);  border-color: #fecaca; }
  .pill-lod { background: var(--bg); color: var(--gray-dk); border-color: var(--border); }

  .hint { font-size: 11.5px; color: var(--gray-md); margin-top: 3px; }


  /* ── PDF Preview Modal ── */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 20px;
    animation: fadeIn 0.18s ease;
  }

  .modal-box {
    background: var(--white);
    border-radius: 10px;
    width: 100%;
    max-width: 680px;
    max-height: 88vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 20px 60px rgba(0,0,0,0.25);
    overflow: hidden;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .modal-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--black);
    letter-spacing: -0.01em;
  }

  .modal-close {
    width: 28px; height: 28px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: var(--gray-md);
    font-size: 13px;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.13s;
  }
  .modal-close:hover { background: var(--bg); color: var(--black); }

  .modal-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    padding: 14px 20px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  /* ── PDF Preview Modal ── */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 16px;
  }

  .modal-box {
    background: white;
    border-radius: 10px;
    width: 100%;
    max-width: 700px;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 24px 64px rgba(0,0,0,0.28);
    overflow: hidden;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .modal-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--black);
  }

  .modal-close {
    width: 28px; height: 28px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: var(--gray-md);
    font-size: 14px;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.13s;
  }
  .modal-close:hover { background: var(--bg); color: var(--black); }

  .modal-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    padding: 14px 20px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  /* ── PDF paper wrapper ── */
  .pdf-doc {
    flex: 1;
    overflow-y: auto;
    background: #dedede;
    padding: 20px;
  }

  .pdf-paper {
    background: #fff;
    max-width: 620px;
    margin: 0 auto;
    padding: 32px 36px 28px;
    box-shadow: 0 2px 16px rgba(0,0,0,0.15);
    font-family: Georgia, 'Times New Roman', serif;
    color: #000;
    font-size: 11px;
  }

  /* Letterhead */
  .pdf-lh {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 14px;
  }

  .pdf-company {
    font-family: Arial, sans-serif;
    font-size: 22px;
    font-weight: 500;
    color: #000;
    letter-spacing: 0.01em;
    line-height: 1;
  }

  .pdf-lh-right {
    font-family: Arial, sans-serif;
    font-size: 9.5px;
    color: #222;
    line-height: 1.75;
    text-align: left;
  }

  .pdf-lh-gap { margin-top: 5px; }

  /* Rules */
  .pdf-rule-thick {
    height: 1px;
    background: #000;
    margin-bottom: 2px;
  }

  /* QUOTATION title */
  .pdf-title-row {
    font-family: Arial, sans-serif;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.12em;
    color: #000;
    margin: 14px 0 24px 0;
    text-align: left;
  }

  /* Meta row */
  .pdf-meta {
    display: flex;
    gap: 48px;
    margin-bottom: 12px;
  }

  .pdf-meta-label {
    font-family: Arial, sans-serif;
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #888;
    margin-bottom: 3px;
  }

  .pdf-meta-value {
    font-family: Arial, sans-serif;
    font-size: 12px;
    font-weight: 700;
    color: #000;
  }

  /* Table */
  table.pdf-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
    margin-top: 4px;
  }

  table.pdf-table th {
    font-family: Arial, sans-serif;
    font-size: 8.5px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #000;
    padding: 8px 10px;
    text-align: center;
    background: #dcdcdc;
    border: 0.5px solid #aaa;
  }

  table.pdf-table td {
    padding: 8px 10px;
    font-family: Arial, sans-serif;
    font-size: 11px;
    color: #000;
    border: 0.5px solid #ccc;
    text-align: center;
  }

  .pdf-row-alt td { background: #f7f7f7; }

  .pdf-count-tag {
    display: inline-block;
    background: #111;
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    padding: 1px 7px;
    border-radius: 3px;
    letter-spacing: 0.04em;
    font-family: Arial, sans-serif;
  }

  /* Footer note */
  .pdf-footer-note {
    font-family: Arial, sans-serif;
    font-size: 8.5px;
    color: #aaa;
    margin-top: 16px;
    text-align: center;
    letter-spacing: 0.02em;
  }

  .pdf-rule-thin {
    height: 0.5px;
    background: #bbb;
    margin: 10px 0;
  }

  @media (max-width: 600px) {
    .app { padding: 12px 10px 40px; }
    .rows-head, .row { grid-template-columns: 1fr 1fr; gap: 8px; }
    .btn-rm { grid-column: 2; justify-self: end; }
    .header-card { flex-direction: column; align-items: flex-start; }
  }
`;

// ─── Row factory ──────────────────────────────────────────────────────────────
const mkRow = () => ({
  id: Date.now() + Math.random(),
  count: "", countLabel: "",
  supplier: "", supplierName: "",
  rate: "",
  suppliers: [],
  loadingSuppliers: false,
});

// ─── Component ────────────────────────────────────────────────────────────────
export default function LeadQuotation() {
  const [leads, setLeads]           = useState([]);
  const [countItems, setCountItems] = useState([]);
  const [selectedLead, setLead]     = useState("");
  const [rows, setRows]             = useState([mkRow()]);
  const [booting, setBooting]       = useState(true);
  const [bootErr, setBootErr]       = useState("");
  const [status, setStatus]         = useState(null); // { t: ok|err|lod, m: string }
  const [submitting, setSubmitting] = useState(false);
  const [showModal, setShowModal] = useState(false);

  // Boot: load leads + counts in parallel
  useEffect(() => {
    Promise.all([fetchLeads(), fetchCountItems()])
      .then(([l, c]) => {
        setLeads(l);
        setCountItems(c);
        console.log("[boot] leads:", l.length, "counts:", c.length);
      })
      .catch((e) => {
        console.error("[boot]", e);
        setBootErr("Could not connect to Monday.com — check your API token and board IDs.");
      })
      .finally(() => setBooting(false));
  }, []);

  // When count changes: fetch suppliers for that count
  async function onCountChange(rowId, countId) {
    const ci = countItems.find((c) => c.id === countId);
    setRows((p) =>
      p.map((r) =>
        r.id === rowId
          ? { ...r, count: countId, countLabel: ci?.label || ci?.name || "", supplier: "", supplierName: "", suppliers: [], loadingSuppliers: !!countId }
          : r
      )
    );
    if (!countId) return;

    const sups = await fetchSuppliersByCountId(countId);
    setRows((p) =>
      p.map((r) => (r.id === rowId ? { ...r, suppliers: sups, loadingSuppliers: false } : r))
    );
  }

  function onSupplierChange(rowId, supId) {
    setRows((p) =>
      p.map((r) => {
        if (r.id !== rowId) return r;
        const s = r.suppliers.find((x) => x.id === supId);
        return { ...r, supplier: supId, supplierName: s?.name || "" };
      })
    );
  }

  function onRateChange(rowId, val) {
    setRows((p) => p.map((r) => (r.id === rowId ? { ...r, rate: val } : r)));
  }

  // Filter out already-selected suppliers for the same count
  function availableSuppliers(row) {
    const used = rows
      .filter((r) => r.id !== row.id && r.count === row.count && r.supplier)
      .map((r) => r.supplier);
    return row.suppliers.filter((s) => !used.includes(s.id));
  }

  async function onSubmit() {
    if (!selectedLead) { setStatus({ t: "err", m: "Please select a lead." }); return; }
    const valid = rows.filter((r) => r.count && r.supplier && r.rate);
    if (!valid.length) { setStatus({ t: "err", m: "Complete at least one row (count + supplier + rate)." }); return; }

    setSubmitting(true);
    setStatus({ t: "lod", m: "Creating subitems…" });
    try {
      const lead = leads.find((l) => l.id === selectedLead);
      const leadName = lead?.name || "Lead";

      // Step 1: create subitems with mapped columns
      setStatus({ t: "lod", m: "Creating subitems…" });
      await createSubitems(selectedLead, valid);

      // Step 2: generate PDF and upload to Documents column
      setStatus({ t: "lod", m: "Generating & uploading PDF…" });
      await createAndUploadPdf(selectedLead, valid, leadName);

      setStatus({ t: "ok", m: `Done — ${valid.length} subitem(s) + PDF added to "${leadName}".` });
      setRows([mkRow()]);
      setLead("");
      setShowModal(false);
    } catch (e) {
      console.error(e);
      setStatus({ t: "err", m: "Something went wrong — check board permissions." });
    } finally {
      setSubmitting(false);
    }
  }

  const validRows = rows.filter((r) => r.count && r.supplier && r.rate);
  const leadName  = leads.find((l) => l.id === selectedLead)?.name || "";

  return (
    <>
      <style>{CSS}</style>
      <div className="app">
        <div className="page">

          {/* ── Header card: title left, buttons right ── */}
          <div className="card header-card">
            <div className="header-left">
              <div className="header-title">Lead Quotation</div>
              <div className="header-sub">monday.com · thread count · supplier pricing</div>
            </div>
            <div className="header-actions">
              {status && (
                <div className={`status-pill ${status.t === "ok" ? "pill-ok" : status.t === "err" ? "pill-err" : "pill-lod"}`}>
                  {status.t === "lod" && <span className="spin" />}
                  {status.t === "ok" && "✓"}
                  {status.t === "err" && "⚠"}
                  {status.m}
                </div>
              )}
              <button
                className="btn btn-outline"
                onClick={() => setShowModal(true)}
                disabled={!validRows.length}
              >
                Preview PDF
              </button>
              <button
                className="btn btn-primary"
                onClick={onSubmit}
                disabled={!selectedLead || !validRows.length || submitting}
              >
                {submitting && <span className="spin" />}
                {submitting ? "Generating…" : "Generate"}
              </button>
            </div>
          </div>

          {bootErr && (
            <div className="status-pill pill-err" style={{ width: "100%" }}>⚠ {bootErr}</div>
          )}

          {/* ── Step 1: Select Lead ── */}
          <div className="card">
            <div className="section-head">
              <div className="section-num">1</div>
              <h2>Select Lead</h2>
            </div>
            <div className="section-body">
              {booting ? (
                <div className="load-row"><span className="spin" /> Loading leads…</div>
              ) : (
                <div className="field">
                  <label>Lead / Opportunity</label>
                  <div className="sel-wrap">
                    <select
                      value={selectedLead}
                      onChange={(e) => { setLead(e.target.value); setStatus(null); }}
                      disabled={!leads.length}
                    >
                      <option value="">
                        {leads.length ? "Select a lead…" : "No leads found — check VITE_LEADS_BOARD_ID"}
                      </option>
                      {leads.map((l) => (
                        <option key={l.id} value={l.id}>{l.name}</option>
                      ))}
                    </select>
                  </div>
                  {selectedLead && (
                    <span className="hint">
                      ↳ Quotation doc &amp; subitems will be created on <strong>{leadName}</strong>
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── Step 2: Quotation Lines ── */}
          <div className="card">
            <div className="section-head">
              <div className="section-num">2</div>
              <h2>Quotation Lines</h2>
            </div>
            <div className="section-body">

              {rows.length === 0 ? (
                <div className="empty">No rows yet — click Add Row below.</div>
              ) : (
                <>
                  <div className="rows-head">
                    <span>Thread Count</span>
                    <span>Supplier</span>
                    <span>Rate</span>
                    <span />
                  </div>

                  {rows.map((row) => {
                    const av = availableSuppliers(row);
                    return (
                      <div key={row.id} className="row">

                        {/* Count dropdown */}
                        <div className="field">
                          <div className="sel-wrap">
                            <select
                              value={row.count}
                              onChange={(e) => onCountChange(row.id, e.target.value)}
                              disabled={booting || !countItems.length}
                            >
                              <option value="">
                                {booting ? "Loading…" : countItems.length ? "Select count…" : "No counts found"}
                              </option>
                              {countItems.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {/* Show Thread Count label e.g. "20s" */}
                                  {c.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>

                        {/* Supplier dropdown */}
                        <div className="field">
                          <div className="sel-wrap">
                            {row.loadingSuppliers ? (
                              <select disabled><option>Loading suppliers…</option></select>
                            ) : (
                              <select
                                value={row.supplier}
                                onChange={(e) => onSupplierChange(row.id, e.target.value)}
                                disabled={!row.count || !av.length}
                              >
                                <option value="">
                                  {!row.count
                                    ? "Select count first…"
                                    : av.length
                                    ? "Select supplier…"
                                    : "No suppliers available"}
                                </option>
                                {av.map((s) => (
                                  <option key={s.id} value={s.id}>{s.name}</option>
                                ))}
                              </select>
                            )}
                          </div>
                        </div>

                        {/* Rate field */}
                        <div className="field">
                          <input
                            type="text"
                            placeholder="e.g. 250"
                            value={row.rate}
                            onChange={(e) => onRateChange(row.id, e.target.value)}
                            disabled={!row.supplier}
                          />
                        </div>

                        {/* Remove row */}
                        <button
                          className="btn-rm"
                          onClick={() => setRows((p) => p.filter((r) => r.id !== row.id))}
                          title="Remove row"
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                </>
              )}

              <button
                className="btn-add-row"
                onClick={() => setRows((p) => [...p, mkRow()])}
              >
                + Add Row
              </button>


            </div>
          </div>

        </div>

          {/* ── PDF Preview Modal ── */}
          {showModal && (
            <div className="modal-overlay" onClick={() => setShowModal(false)}>
              <div className="modal-box" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                  <div className="modal-title">Quotation Preview</div>
                  <button className="modal-close" onClick={() => setShowModal(false)}>✕</button>
                </div>

                {/* PDF paper preview */}
                <div className="pdf-doc">
                  <div className="pdf-paper">

                    {/* Letterhead: company left, address right */}
                    <div className="pdf-lh">
                      <div className="pdf-company">KAARTHIKA AGENCY</div>
                      <div className="pdf-lh-right">
                        <div>234 Union Mill Road</div>
                        <div>PAN NO. AHFPS5121G</div>
                        <div>MOBILE NO. 9487411111</div>
                        <div className="pdf-lh-gap">Phone No &nbsp;: 2201147, 2201138, 2201139</div>
                        <div>Fax No &nbsp;&nbsp;&nbsp;&nbsp;: 0421-2202245</div>
                        <div>kaarthikaagency@gmail.com</div>
                      </div>
                    </div>

                    {/* Single thick rule */}
                    <div className="pdf-rule-thick" />

                    {/* QUOTATION — left aligned */}
                    <div className="pdf-title-row">QUOTATION</div>

                    {/* Meta: Customer/Buyer + Date & Time */}
                    <div className="pdf-meta">
                      <div>
                        <div className="pdf-meta-label">Customer / Buyer</div>
                        <div className="pdf-meta-value">{leadName || "—"}</div>
                      </div>
                      <div>
                        <div className="pdf-meta-label">Date &amp; Time</div>
                        <div className="pdf-meta-value">
                          {new Date().toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" })}
                          {"  "}
                          {new Date().toLocaleTimeString("en-IN", { hour:"2-digit", minute:"2-digit", hour12:true })}
                        </div>
                      </div>
                    </div>

                    {/* Table */}
                    <table className="pdf-table">
                      <thead>
                        <tr>
                          <th style={{ width: 36, textAlign:"center" }}>S.No</th>
                          <th style={{ width: 110, textAlign:"center" }}>Thread Count</th>
                          <th style={{ textAlign:"center" }}>Supplier</th>
                          <th style={{ width: 80, textAlign:"center" }}>Rate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {validRows.map((r, i) => (
                          <tr key={r.id} className={i % 2 === 1 ? "pdf-row-alt" : ""}>
                            <td style={{ textAlign:"center" }}>{i + 1}</td>
                            <td style={{ textAlign:"center" }}><span className="pdf-count-tag">{r.countLabel || r.count}</span></td>
                            <td style={{ textAlign:"center" }}>{r.supplierName || r.supplier}</td>
                            <td style={{ textAlign:"center", fontWeight:600 }}>{r.rate}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    <div className="pdf-footer-note">This is a computer generated quotation.</div>

                  </div>
                </div>

                {/* Modal actions */}
                <div className="modal-actions">
                  <button className="btn btn-outline" onClick={() => setShowModal(false)}>
                    Close
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={onSubmit}
                    disabled={!selectedLead || submitting}
                  >
                    {submitting && <span className="spin" />}
                    {submitting ? "Generating…" : "Generate & Upload"}
                  </button>
                </div>
              </div>
            </div>
          )}

      </div>
    </>
  );
}
