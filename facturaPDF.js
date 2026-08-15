/**
 * facturaPDF.js — Genera el PDF de la factura con el formato estándar
 * ---------------------------------------------------------------------
 * Arma el comprobante en el formato visual típico de una factura
 * electrónica argentina: recuadro con la letra (A/B/C) y el código,
 * datos del emisor, receptor, detalle, totales, QR de verificación
 * y CAE — igual a lo que emite cualquier sistema de facturación real.
 */

const https = require("https");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");

const NOMBRES_TIPO = { A: "Factura A", B: "Factura B", C: "Factura C" };
const CODIGO_TIPO = { A: "001", B: "006", C: "011" }; // código de comprobante AFIP/ARCA

/** Arma la URL del QR oficial de verificación de ARCA (formato fijo). */
function armarLinkVerificacionARCA({ cuitEmisor, ptoVta, tipoComprobante, nroComprobante, total, cae, fecha, tipoDocRec = 99, nroDocRec = 0 }) {
  const datos = {
    ver: 1,
    fecha: fecha || new Date().toISOString().slice(0, 10),
    cuit: Number(cuitEmisor),
    ptoVta: Number(ptoVta),
    tipoCmp: Number(CODIGO_TIPO[tipoComprobante].replace(/^0+/, "") || 6),
    nroCmp: Number(nroComprobante),
    importe: Number(total),
    moneda: "PES",
    ctz: 1,
    tipoDocRec,
    nroDocRec,
    tipoCodAut: "E",
    codAut: Number(cae),
  };
  const base64 = Buffer.from(JSON.stringify(datos)).toString("base64");
  return `https://www.afip.gob.ar/fe/qr/?p=${base64}`;
}

/** Intenta bajar una imagen QR de un generador público (gratis, sin
 * key). Si falla por lo que sea (sin internet, servicio caído), no
 * frena el PDF — sigue sin la imagen y deja el link como texto. */
function descargarImagenQR(url) {
  const apiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;
  console.log(`  [debug] descargarImagenQR: GET ${apiUrl}`);
  return new Promise((resolve) => {
    const req = https
      .get(apiUrl, { timeout: 5000 }, (res) => {
        console.log(`  [debug] descargarImagenQR: respuesta HTTP ${res.statusCode}`);
        if (res.statusCode !== 200) return resolve(null);
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          console.log(`  [debug] descargarImagenQR: descarga completa (${Buffer.concat(chunks).length} bytes)`);
          resolve(Buffer.concat(chunks));
        });
      })
      .on("error", (e) => {
        console.log(`  [debug] descargarImagenQR: error de red — ${e.message}`);
        resolve(null);
      });
    req.on("timeout", () => {
      console.log("  [debug] descargarImagenQR: timeout (5s) — abortando request");
      req.destroy();
      resolve(null);
    });
  });
}

function money(n) {
  return Number(n).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function generarPDFFactura(datos) {
  const {
    tipoComprobante, ptoVta, nroComprobante, fechaEmision,
    emisorRazonSocial, emisorDomicilio, emisorCuit, emisorCondicionIva, emisorIIBB, emisorInicioActividades,
    receptorNombre, receptorCuit, receptorCondicionIva,
    items, // [{ descripcion, cantidad, precioUnitario, total }]
    neto, iva, total,
    cae, vencimientoCae,
  } = datos;

  console.log("  [debug] generarPDFFactura: creando PDFDocument...");
  const pdfDoc = await PDFDocument.create();
  console.log("  [debug] generarPDFFactura: PDFDocument creado, agregando página...");
  const page = pdfDoc.addPage([595, 780]); // A4 aprox en puntos
  console.log("  [debug] generarPDFFactura: embebiendo fuentes...");
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  console.log("  [debug] generarPDFFactura: fuentes listas.");

  const black = rgb(0.1, 0.1, 0.1);
  const gray = rgb(0.45, 0.45, 0.45);
  let y = 740;
  const left = 40;
  const right = 555;

  const draw = (text, x, yPos, opts = {}) => {
    page.drawText(String(text), { x, y: yPos, size: opts.size || 10, font: opts.bold ? fontBold : font, color: opts.color || black });
  };
  const line = (yPos) => page.drawLine({ start: { x: left, y: yPos }, end: { x: right, y: yPos }, thickness: 0.5, color: gray });

  // ---- Recuadro superior con la letra ----
  const boxX = 270, boxY = 700, boxW = 55, boxH = 55;
  page.drawRectangle({ x: boxX, y: boxY, width: boxW, height: boxH, borderColor: black, borderWidth: 1.5 });
  page.drawText(tipoComprobante, { x: boxX + boxW / 2 - 8, y: boxY + boxH / 2 - 10, size: 26, font: fontBold, color: black });
  draw(`Código ${CODIGO_TIPO[tipoComprobante]}`, boxX - 2, boxY - 12, { size: 8, color: gray });

  // ---- Título y datos del comprobante (derecha) ----
  draw("FACTURA ELECTRONICA", 380, 745, { bold: true, size: 13 });
  draw(`Punto de Venta: ${String(ptoVta).padStart(4, "0")}    Comp Nro: ${String(nroComprobante).padStart(8, "0")}`, 380, 728, { size: 9 });
  draw(`FECHA EMISIÓN: ${fechaEmision}`, 380, 712, { size: 9, bold: true });

  // ---- Datos del emisor (izquierda) ----
  draw(emisorRazonSocial, left, 745, { bold: true, size: 12 });
  if (emisorDomicilio) draw(emisorDomicilio, left, 730, { size: 9 });
  draw(`C.U.I.T. Nº: ${emisorCuit}`, 380, 696, { size: 9, bold: true });
  if (emisorIIBB) draw(`IIBB: ${emisorIIBB}`, 380, 682, { size: 9, bold: true });
  if (emisorInicioActividades) draw(`FECHA DE INICIO DE ACTIVIDADES: ${emisorInicioActividades}`, 380, 668, { size: 9, bold: true });
  draw(`${etiquetaCondicionIva(emisorCondicionIva)}`, 380, 654, { size: 9, bold: true });

  y = 630;
  line(y);
  y -= 20;

  // ---- Receptor ----
  const receptorTxt = receptorCuit
    ? `A: ${receptorNombre || ""} — CUIT ${receptorCuit} (${etiquetaCondicionIva(receptorCondicionIva)})`
    : "A consumidor final";
  draw(receptorTxt, left, y, { size: 10 });
  y -= 25;
  line(y);
  y -= 20;

  // ---- Tabla de items ----
  draw("DESCRIPCIÓN", left, y, { bold: true, size: 9 });
  draw("CANTIDAD", 330, y, { bold: true, size: 9 });
  draw("PRECIO", 410, y, { bold: true, size: 9 });
  draw("TOTAL", 490, y, { bold: true, size: 9 });
  y -= 8;
  line(y);
  y -= 16;

  for (const item of items) {
    draw(item.descripcion, left, y, { size: 9 });
    draw(String(item.cantidad), 340, y, { size: 9 });
    draw(money(item.precioUnitario), 405, y, { size: 9 });
    draw(money(item.total), 485, y, { size: 9 });
    y -= 16;
  }

  y -= 10;
  line(y);
  y -= 14;
  draw("Los precios y totales del detalle incluyen IVA. El cuadro de abajo discrimina el IVA contenido en ese total.", left, y, {
    size: 7,
    color: gray,
  });
  y -= 46;

  // ---- Totales ----
  draw("Neto:", 420, y + 30, { size: 9 });
  draw(`$ ${money(neto)}`, 490, y + 30, { size: 9 });
  draw("IVA:", 420, y + 16, { size: 9 });
  draw(`$ ${money(iva)}`, 490, y + 16, { size: 9 });
  draw("TOTAL:", 420, y, { bold: true, size: 11 });
  draw(`$ ${money(total)}`, 485, y, { bold: true, size: 11 });

  // ---- Pie: QR + CAE ----
  console.log("  [debug] generarPDFFactura: dibujando pie de página...");
  const pieY = 90;
  page.drawLine({ start: { x: left, y: pieY + 60 }, end: { x: right, y: pieY + 60 }, thickness: 0.5, color: gray });

  console.log("  [debug] generarPDFFactura: ANTES de armar el link de verificación / descargarImagenQR");
  let qrBuffer = null;
  try {
    const linkVerificacion = armarLinkVerificacionARCA({
      cuitEmisor: emisorCuit.replace(/-/g, ""), ptoVta, tipoComprobante, nroComprobante, total, cae,
      tipoDocRec: receptorCuit ? 80 : 99, nroDocRec: receptorCuit || 0,
    });
    console.log(`  [debug] generarPDFFactura: link de verificación armado: ${linkVerificacion}`);
    qrBuffer = await descargarImagenQR(linkVerificacion);
  } catch (e) {
    console.log(`  [debug] generarPDFFactura: excepción armando/descargando QR — ${e.message}`);
    qrBuffer = null;
  }
  console.log(`  [debug] generarPDFFactura: DESPUÉS de descargarImagenQR — qrBuffer ${qrBuffer ? `OK (${qrBuffer.length} bytes)` : "null"}`);

  if (qrBuffer) {
    try {
      console.log("  [debug] generarPDFFactura: embebiendo imagen QR en el PDF...");
      const qrImage = await pdfDoc.embedPng(qrBuffer);
      page.drawImage(qrImage, { x: left, y: pieY - 20, width: 70, height: 70 });
      console.log("  [debug] generarPDFFactura: QR embebido OK.");
    } catch (e) {
      console.log(`  [debug] generarPDFFactura: la imagen QR no se pudo embeber (${e.message}) — sigo sin ella.`);
    }
  }

  draw("Comprobante Autorizado", left + 80, pieY + 30, { size: 8, color: gray });
  draw("** ORIGINAL **", 420, pieY + 40, { bold: true, size: 10 });
  draw(`C.A.E. Nº: ${cae}`, 420, pieY + 22, { size: 9 });
  draw(`Fecha Vto CAE: ${vencimientoCae}`, 420, pieY + 8, { size: 9 });

  console.log("  [debug] generarPDFFactura: guardando PDF final...");
  const resultado = Buffer.from(await pdfDoc.save());
  console.log(`  [debug] generarPDFFactura: PDF guardado (${resultado.length} bytes). Retornando.`);
  return resultado;
}

function etiquetaCondicionIva(condicion) {
  const mapa = {
    responsable_inscripto: "I.V.A. RESPONSABLE INSCRIPTO",
    monotributo: "RESPONSABLE MONOTRIBUTO",
    exento: "I.V.A. SUJETO EXENTO",
    consumidor_final: "CONSUMIDOR FINAL",
  };
  return mapa[condicion] || condicion || "";
}

module.exports = { generarPDFFactura, armarLinkVerificacionARCA };
