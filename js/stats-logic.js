/* -------------------------------------------------------------------------- */
/* STATISTICS MODAL LOGIC                                                     */
/* -------------------------------------------------------------------------- */

const statsBtn = document.getElementById("statsBtn");
const statsModal = document.getElementById("statsModal");
const statsModalCloseBtn = document.getElementById("statsModalCloseBtn");
const statsModalBackdrop = document.getElementById("statsModalBackdrop");
const statsFilterBlock = document.getElementById("statsFilterBlock");
const statsGenerateBtn = document.getElementById("statsGenerateBtn");

if (statsBtn && statsModal) {
  statsBtn.addEventListener("click", () => {
    statsModal.hidden = false;
    statsModal.setAttribute("aria-hidden", "false");
    populateStatsBlocksDropdown();
  });

  const closeStats = () => {
    statsModal.hidden = true;
    statsModal.setAttribute("aria-hidden", "true");
  };

  statsModalCloseBtn.addEventListener("click", closeStats);
  statsModalBackdrop.addEventListener("click", closeStats);
  
  statsGenerateBtn.addEventListener("click", generateStatisticsReport);
}

async function populateStatsBlocksDropdown() {
  if (statsFilterBlock.options.length > 1) return; // already populated
  
  const { data, error } = await supabase
    .from("vsl_blocks")
    .select("id, block_name, block_code")
    .order("block_code");
    
  if (error) {
    console.error("Failed to load blocks for stats:", error);
    return;
  }
  
  data.forEach(b => {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = `${b.block_code} - ${b.block_name}`;
    statsFilterBlock.appendChild(opt);
  });
}

async function generateStatisticsReport() {
  const blockId = statsFilterBlock.value;
  const fromDate = document.getElementById("statsFilterFrom").value;
  const toDate = document.getElementById("statsFilterTo").value;
  
  document.getElementById("statsGenerateBtn").innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
  
  try {
    // 1. Fetch block aggregate stats
    let statsQuery = supabase.from("vsl_block_stats").select("*");
    if (blockId !== "ALL") {
      statsQuery = statsQuery.eq("block_id", blockId);
    }
    
    const { data: statsData, error: statsError } = await statsQuery;
    if (statsError) throw statsError;
    
    let totalArea = 0, harvestedArea = 0, cultivatedArea = 0, idlePlots = 0;
    
    statsData.forEach(r => {
      totalArea += r.total_parcel_area_acres || 0;
      harvestedArea += r.harvested_plots_area_acres || 0;
      cultivatedArea += r.cultivated_plots_area_acres || 0;
      idlePlots += r.idle_plots_count || 0;
    });
    
    document.getElementById("statTotalArea").textContent = totalArea.toFixed(2);
    document.getElementById("statHarvestedArea").textContent = harvestedArea.toFixed(2);
    document.getElementById("statCultivatedArea").textContent = cultivatedArea.toFixed(2);
    document.getElementById("statIdlePlots").textContent = idlePlots;
    
    // 2. Fetch Harvest History
    let harvestQuery = supabase.from("vsl_harvests").select("harvest_date, gross_weight_tonnes, parcel_id, vsl_parcels(parcel_label, block_id, vsl_blocks(block_code))").order("harvest_date", { ascending: false }).limit(50);
    
    if (fromDate) harvestQuery = harvestQuery.gte("harvest_date", fromDate);
    if (toDate) harvestQuery = harvestQuery.lte("harvest_date", toDate);
    
    const { data: harvestData, error: hError } = await harvestQuery;
    if (hError) throw hError;
    
    // Filter by block if needed
    const filteredHarvests = blockId === "ALL" ? harvestData : harvestData.filter(h => h.vsl_parcels?.block_id === blockId);
    
    // 3. Render table
    const tbody = document.querySelector("#statsDataTable tbody");
    tbody.innerHTML = "";
    
    if (filteredHarvests.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#888;">No harvest records found for this period.</td></tr>';
    } else {
      filteredHarvests.forEach(h => {
        const blockCode = h.vsl_parcels?.vsl_blocks?.block_code || "Unknown";
        const parcelLabel = h.vsl_parcels?.parcel_label || "Unknown";
        
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td><strong>${blockCode}</strong> / ${parcelLabel}</td>
          <td><span style="background:#eef5ec;color:#2d6a3a;padding:2px 6px;border-radius:4px;font-size:0.75rem;font-weight:700;text-transform:uppercase;">Harvest</span></td>
          <td>${h.harvest_date}</td>
          <td style="font-weight:700;">${h.gross_weight_tonnes} tonnes</td>
        `;
        tbody.appendChild(tr);
      });
    }
    
  } catch (err) {
    alert("Error generating report: " + err.message);
  } finally {
    document.getElementById("statsGenerateBtn").innerHTML = 'Generate Report';
  }
}
