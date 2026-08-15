/**
 * sheetsAPI.js — Escritura en Google Sheets vía cuenta de servicio
 * ---------------------------------------------------------------------
 * Complementa a conectores/planilla.js: ese conector LEE la planilla
 * por el link público "Publicado como CSV" (sin login). Para ESCRIBIR
 * de vuelta (marcar "facturado", poner el CAE y el total) hace falta
 * autenticación real, por eso este módulo usa la Google Sheets API con
 * una cuenta de servicio.
 *
 * Requiere:
 *   - credenciales-google-sheets.json (cuenta de servicio) al lado de
 *     este archivo — nunca se sube a ningún repositorio (ver .gitignore).
 *   - Que esa cuenta de servicio (el "client_email" del JSON) esté
 *     agregada como Editor en la planilla real (no en la publicada).
 */

const path = require("path");
const { google } = require("googleapis");

const CREDENCIALES_PATH = path.join(__dirname, "credenciales-google-sheets.json");

let clienteSheetsPromise = null;

function obtenerCliente() {
  if (!clienteSheetsPromise) {
    const auth = new google.auth.GoogleAuth({
      keyFile: CREDENCIALES_PATH,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    clienteSheetsPromise = auth.getClient().then((authClient) => google.sheets({ version: "v4", auth: authClient }));
  }
  return clienteSheetsPromise;
}

/** Convierte un índice de columna base 0 a letra de columna A1 (0->A, 1->B, ..., 26->AA). */
function columnaA1(indice) {
  let n = indice + 1;
  let letra = "";
  while (n > 0) {
    const resto = (n - 1) % 26;
    letra = String.fromCharCode(65 + resto) + letra;
    n = Math.floor((n - 1) / 26);
  }
  return letra;
}

/** Busca el título de la hoja (tab) que corresponde a un gid numérico.
 * Hace falta porque la API de valores necesita el TÍTULO de la hoja en
 * la notación A1 (ej. "Hoja 1!E5"), no el gid que aparece en la URL. */
async function obtenerTituloHoja(spreadsheetId, gid) {
  const sheets = await obtenerCliente();
  const { data } = await sheets.spreadsheets.get({ spreadsheetId });
  const hoja = data.sheets.find((h) => String(h.properties.sheetId) === String(gid));
  if (!hoja) {
    throw new Error(`No encontré ninguna hoja con gid=${gid} en la planilla ${spreadsheetId}.`);
  }
  return hoja.properties.title;
}

/**
 * Escribe varias celdas de una misma fila de una sola vez.
 * `valoresPorColumna` es un objeto { indiceColumna: valor }.
 */
async function escribirFila(spreadsheetId, tituloHoja, filaSheet, valoresPorColumna) {
  const sheets = await obtenerCliente();
  const data = Object.entries(valoresPorColumna).map(([indiceColumna, valor]) => ({
    range: `${tituloHoja}!${columnaA1(Number(indiceColumna))}${filaSheet}`,
    values: [[valor]],
  }));

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data,
    },
  });
}

module.exports = { obtenerTituloHoja, escribirFila, columnaA1 };
