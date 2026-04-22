function doPost(e) {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = spreadsheet.getSheetByName('Movimientos') || spreadsheet.insertSheet('Movimientos');

  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'id',
      'fecha',
      'tipo',
      'titulo',
      'monto',
      'categoria',
      'cuenta',
      'origen',
      'nota',
      'estado_sync',
      'owner',
      'exported_at',
    ]);
  }

  var payload = JSON.parse(e.postData.contents);
  var rows = payload.transactions.map(function (item) {
    return [
      item.id,
      item.date,
      item.kind,
      item.title,
      item.amount,
      item.category,
      item.account,
      item.source,
      item.note || '',
      item.syncStatus,
      payload.owner,
      payload.exportedAt,
    ];
  });

  if (rows.length > 0) {
    sheet
      .getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length)
      .setValues(rows);
  }

  return ContentService.createTextOutput(
    JSON.stringify({
      ok: true,
      inserted: rows.length,
    }),
  ).setMimeType(ContentService.MimeType.JSON);
}
