/* -------------------------------------------------------------------------- */
/* STATISTICS MODAL LOGIC                                                     */
/* -------------------------------------------------------------------------- */
import { createSupabaseClient } from "./supabase-client.js";
const supabase = createSupabaseClient();

const statsBtn = document.getElementById("statsBtn");
const statsModal = document.getElementById("statsModal");
const statsModalCloseBtn = document.getElementById("statsModalCloseBtn");

const statsFilterEstate = document.getElementById("statsFilterEstate");
const statsFilterBlock = document.getElementById("statsFilterBlock");
const statsGenerateBtn = document.getElementById("statsGenerateBtn");

const statsMailRecipients = document.getElementById("statsMailRecipients");
const statsNewEmailInput = document.getElementById("statsNewEmailInput");
const statsAddEmailBtn = document.getElementById("statsAddEmailBtn");

let allBlocksData = [];

if (statsBtn && statsModal) {
  statsBtn.addEventListener("click", () => {
    statsModal.hidden = false;
    statsModal.setAttribute("aria-hidden", "false");
    statsModal.style.display = "flex";
    populateStatsDropdowns();
    loadRecipients();
  });

  const closeStats = () => {
    statsModal.hidden = true;
    statsModal.setAttribute("aria-hidden", "true");
    statsModal.style.display = "none";
  };

  statsModalCloseBtn.addEventListener("click", closeStats);
  
  statsModalCloseBtn.addEventListener("click", closeStats);
  
  statsGenerateBtn.addEventListener("click", async () => {
    const checkboxes = statsMailRecipients.querySelectorAll('input[type="checkbox"]:checked');
    const selected = Array.from(checkboxes).map(cb => cb.value);
    
    // First generate the report data and UI
    const success = await generateStatisticsReport();
    if (!success) return;
    
    // Then generate the PDF
    statsGenerateBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating PDF...';
    
    const exportArea = document.getElementById("statsExportArea");
    const exportHeader = document.getElementById("statsExportHeader");
    const exportDate = document.getElementById("statsExportDate");
    
    exportDate.textContent = `Generated: ${new Date().toLocaleString()}`;
    exportHeader.style.display = "block";
    
    const opt = {
      margin:       0.5,
      filename:     'Victoria_Sugar_Agronomy_Report.pdf',
      image:        { type: 'jpeg', quality: 0.98 },
      html2canvas:  { scale: 2 },
      jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
    };
    
    try {
      await html2pdf().set(opt).from(exportArea).save();
    } catch (err) {
      console.error("PDF Export failed:", err);
      alert("Failed to export PDF.");
    } finally {
      exportHeader.style.display = "none";
      statsGenerateBtn.innerHTML = '<i class="fas fa-file-pdf"></i> Generate, Export & Mail PDF';
    }
    
    // Finally trigger the mailto if recipients selected
    if (selected.length > 0) {
      const to = selected.join(",");
      const subject = encodeURIComponent("Victoria Sugar Agronomy Report");
      const body = encodeURIComponent("Please find the generated Victoria Sugar Agronomy Report attached.\n\n(Note: Automatic PDF attachments will be supported once Resend integration is complete. For now, please manually attach the downloaded PDF.)");
      window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
    }
  });
  // Cascade Dropdowns
  statsFilterEstate.addEventListener("change", (e) => {
    const est = e.target.value;
    statsFilterBlock.innerHTML = '<option value="ALL">All Blocks</option>';
    if (est === "ALL") {
      statsFilterBlock.disabled = true;
    } else {
      statsFilterBlock.disabled = false;
      const filteredBlocks = allBlocksData.filter(b => b.estate_name === est);
      filteredBlocks.forEach(b => {
        const opt = document.createElement("option");
        opt.value = b.id;
        opt.textContent = `${b.block_code} - ${b.block_name}`;
        statsFilterBlock.appendChild(opt);
      });
    }
  });

  // Mail Functions
  statsAddEmailBtn.addEventListener("click", async () => {
    const email = statsNewEmailInput.value.trim();
    if (email && email.includes("@")) {
      statsAddEmailBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
      const { error } = await supabase.from("vsl_report_recipients").insert([{ email }]);
      if (error && error.code !== "23505") { // Ignore unique constraint error
        alert("Error saving email: " + error.message);
      }
      statsNewEmailInput.value = "";
      statsAddEmailBtn.innerHTML = '<i class="fas fa-plus"></i>';
      loadRecipients();
    }
  });

  });
}

async function populateStatsDropdowns() {
  if (statsFilterEstate.options.length > 1) return; // already populated
  
  const { data, error } = await supabase
    .from("vsl_blocks")
    .select("id, block_name, block_code, estate_name")
    .order("block_code");
    
  if (error) {
    console.error("Failed to load blocks for stats:", error);
    return;
  }
  
  allBlocksData = data;
  
  const estates = [...new Set(data.map(b => b.estate_name).filter(Boolean))].sort();
  estates.forEach(est => {
    const opt = document.createElement("option");
    opt.value = est;
    opt.textContent = est;
    statsFilterEstate.appendChild(opt);
  });
}

async function loadRecipients() {
  const { data, error } = await supabase
    .from("vsl_report_recipients")
    .select("email")
    .order("created_at", { ascending: false });
    
  if (error) {
    console.error("Failed to load recipients:", error);
    return;
  }
  
  statsMailRecipients.innerHTML = "";
  if (data.length === 0) {
    statsMailRecipients.innerHTML = '<span style="color:#888; font-style:italic;">No saved emails</span>';
    return;
  }
  
  data.forEach(r => {
    const label = document.createElement("label");
    label.style.cssText = "display:flex; align-items:center; gap:0.5rem; font-size:0.8rem; color:#333; cursor:pointer;";
    
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = r.email;
    cb.style.cursor = "pointer";
    
    label.appendChild(cb);
    label.appendChild(document.createTextNode(r.email));
    
    statsMailRecipients.appendChild(label);
  });
}

async function generateStatisticsReport() {
  const estateFilter = statsFilterEstate.value;
  const blockFilter = statsFilterBlock.value;
  const fromDate = document.getElementById("statsFilterFrom").value;
  const toDate = document.getElementById("statsFilterTo").value;
  
  statsGenerateBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
  
  try {
    // 1. Fetch block aggregate stats
    const { data: statsData, error: statsError } = await supabase.from("vsl_block_stats").select("*");
    if (statsError) throw statsError;
    
    // Filter statsData in memory using allBlocksData
    const filteredStatsData = statsData.filter(row => {
      const b = allBlocksData.find(block => block.id === row.block_id);
      if (!b) return false;
      if (estateFilter !== "ALL" && b.estate_name !== estateFilter) return false;
      if (blockFilter !== "ALL" && row.block_id !== blockFilter) return false;
      return true;
    });
    
    let totalArea = 0, harvestedArea = 0, cultivatedArea = 0, idlePlots = 0;
    filteredStatsData.forEach(r => {
      totalArea += r.total_parcel_area_acres || 0;
      harvestedArea += r.harvested_plots_area_acres || 0;
      cultivatedArea += r.cultivated_plots_area_acres || 0;
      idlePlots += r.idle_plots_count || 0;
    });
    
    document.getElementById("statTotalArea").textContent = totalArea.toFixed(2);
    document.getElementById("statHarvestedArea").textContent = harvestedArea.toFixed(2);
    document.getElementById("statCultivatedArea").textContent = cultivatedArea.toFixed(2);
    document.getElementById("statIdlePlots").textContent = idlePlots;
    
    // 2. Fetch Harvest History with joins
    let harvestQuery = supabase
      .from("vsl_harvests")
      .select("harvest_date, gross_weight_tonnes, vsl_parcels!inner(parcel_label, block_id, vsl_blocks!inner(block_code, estate_name))")
      .order("harvest_date", { ascending: false });
      
    if (fromDate) harvestQuery = harvestQuery.gte("harvest_date", fromDate);
    if (toDate) harvestQuery = harvestQuery.lte("harvest_date", toDate);
    
    const { data: harvestData, error: hError } = await harvestQuery;
    if (hError) throw hError;
    
    // Filter harvests in memory based on dropdowns (since Postgrest deep filtering can be tricky)
    const filteredHarvests = harvestData.filter(h => {
      const p = h.vsl_parcels;
      if (!p) return false;
      if (estateFilter !== "ALL" && p.vsl_blocks?.estate_name !== estateFilter) return false;
      if (blockFilter !== "ALL" && p.block_id !== blockFilter) return false;
      return true;
    });
    
    // 3. Render table (Grouped by Estate > Block)
    const tbody = document.querySelector("#statsDataTable tbody");
    tbody.innerHTML = "";
    
    if (filteredHarvests.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; color:#888; font-size: 0.8rem; padding: 1rem;">No harvest records found for this period.</td></tr>';
      return;
    }
    
    // Grouping
    const grouped = {};
    filteredHarvests.forEach(h => {
      const estate = h.vsl_parcels?.vsl_blocks?.estate_name || "Unknown Estate";
      const blockCode = h.vsl_parcels?.vsl_blocks?.block_code || "Unknown Block";
      
      if (!grouped[estate]) grouped[estate] = {};
      if (!grouped[estate][blockCode]) grouped[estate][blockCode] = [];
      grouped[estate][blockCode].push(h);
    });
    
    // Render Groups
    Object.keys(grouped).sort().forEach(estate => {
      // Estate Header
      const estTr = document.createElement("tr");
      estTr.innerHTML = `<td colspan="3" style="background:#f1f8f4; font-weight:800; color:#1a4a25; font-size:0.75rem; padding:0.4rem 0.6rem;">🏢 Estate: ${estate}</td>`;
      tbody.appendChild(estTr);
      
      Object.keys(grouped[estate]).sort().forEach(blockCode => {
        // Block Header
        const blkTr = document.createElement("tr");
        blkTr.innerHTML = `<td colspan="3" style="background:#fafdf8; font-weight:700; color:#333; font-size:0.75rem; padding:0.3rem 0.6rem; border-bottom: 1px solid #e2ece0;">📍 Block: ${blockCode}</td>`;
        tbody.appendChild(blkTr);
        
        // Harvest Records
        grouped[estate][blockCode].forEach(h => {
          const parcelLabel = h.vsl_parcels?.parcel_label || "Unknown";
          const tr = document.createElement("tr");
          tr.innerHTML = `
            <td style="font-size: 0.75rem; padding: 0.3rem 0.6rem; padding-left: 1.5rem; color:#555;">Parcel: ${parcelLabel}</td>
            <td style="font-size: 0.75rem; padding: 0.3rem 0.6rem; color:#555;">${h.harvest_date}</td>
            <td style="font-size: 0.75rem; padding: 0.3rem 0.6rem; text-align: right; font-weight:700; color:#2d6a3a;">${h.gross_weight_tonnes}</td>
          `;
          tbody.appendChild(tr);
        });
      });
    });
    
    
    return true;
  } catch (err) {
    alert("Error generating report: " + err.message);
    return false;
  } finally {
    if (statsGenerateBtn.innerHTML.includes("Loading")) {
      statsGenerateBtn.innerHTML = '<i class="fas fa-file-pdf"></i> Generate, Export & Mail PDF';
    }
  }
}
