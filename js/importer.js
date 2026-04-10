export async function importAttributesCsv({
  supabase,
  file,
  currentUserId
}) {
  if (!file) {
    throw new Error("Select a CSV file first.");
  }
  if (!window.Papa?.parse) {
    throw new Error("PapaParse is not loaded.");
  }

  const parsed = await new Promise((resolve, reject) => {
    window.Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: resolve,
      error: reject
    });
  });

  const rows = parsed.data || [];
  if (!rows.length) {
    throw new Error("CSV has no data rows.");
  }

  const requiredColumns = ["block_code", "block_name", "estate_name", "expected_area_acres"];
  for (const col of requiredColumns) {
    if (!(col in rows[0])) {
      throw new Error(`Missing required column: ${col}`);
    }
  }

  const batchPayload = {
    source_file_name: file.name,
    imported_by: currentUserId,
    row_count: rows.length,
    status: "processing"
  };

  const { data: batchData, error: batchError } = await supabase
    .from("vsl_import_batches")
    .insert(batchPayload)
    .select("id")
    .single();

  if (batchError) throw batchError;

  const insertRows = rows.map((row, idx) => ({
    batch_id: batchData.id,
    row_number: idx + 1,
    raw_payload: row,
    status: "queued"
  }));

  const { error: rowsError } = await supabase.from("vsl_import_rows").insert(insertRows);
  if (rowsError) throw rowsError;

  const { error: rpcError } = await supabase.rpc("vsl_process_import_batch", {
    p_batch_id: batchData.id
  });
  if (rpcError) throw rpcError;

  return { batchId: batchData.id, rowCount: rows.length };
}
