#!/usr/bin/env node
/**
 * enviarFactura.js — Envío de la factura al cliente
 * ------------------------------------------------------
 * Quinto eslabón del circuito: toma los datos de una factura ya
 * autorizada por ARCA (CAE) y se la manda al cliente por mail.
 *
 * Usa Gmail como servidor de salida (gratis, con una "contraseña de
 * aplicación" — nunca tu contraseña real de Gmail).
 *
 * ---- Cómo conseguir la contraseña de aplicación ----
 * 1. Activá la verificación en 2 pasos en tu cuenta de Google
 *    (myaccount.google.com/security) si todavía no la tenés.
 * 2. Andá a myaccount.google.com/apppasswords
 * 3. Creá una nueva, ponele un nombre como "circuito-ventas", copiá
 *    el código de 16 letras que te da.
 * 4. Guardalo como variable de entorno (nunca lo escribas a mano en
 *    el código ni lo subas a ningún lado):
 *      export GMAIL_USER="tu-cuenta@gmail.com"
 *      export GMAIL_APP_PASSWORD="las 16 letras sin espacios"
 *
 * ---- Uso ----
 *   node enviarFactura.js \
 *     --clienteEmail "cliente@ejemplo.com" \
 *     --clienteNombre "Juan Pérez" \
 *     --cuitEmisor 20448884148 \
 *     --tipoComprobante B \
 *     --ptoVta 1 --nroComprobante 3 \
 *     --cae 86330765426949 --vencimientoCae 20260825 \
 *     --total 45000 --neto 37190.08 --iva 7809.92 \
 *     --itemDescripcion "Silla de madera" --itemCantidad 3 --itemPrecioUnitario 15000
 *
 * Nota: todavía no incluye el link de pago (eso es el próximo
 * eslabón, el portal de cobro) — sí incluye el link oficial de
 * verificación de ARCA (QR), que es obligatorio en toda factura real.
 */

const path = require("path");
const fs = require("fs");
const { generarPDFFactura } = require("./facturaPDF");

function error(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`✓ ${msg}`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    }
  }
  return args;
}

const NOMBRES_TIPO_COMPROBANTE = { A: "Factura A", B: "Factura B", C: "Factura C" };

function armarHTMLMail(datos) {
  return `
  <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0; color: #222;">
    <p>Hola ${datos.clienteNombre || ""},</p>
    <p>Te enviamos adjunto el comprobante correspondiente a tu compra.</p>
    <p style="font-size: 13px; color:#666;">
      ${NOMBRES_TIPO_COMPROBANTE[datos.tipoComprobante]} N° ${String(datos.ptoVta).padStart(4, "0")}-${String(datos.nroComprobante).padStart(8, "0")}<br/>
      CAE: ${datos.cae}
    </p>
    <p style="font-size: 12px; color:#999; margin-top: 24px;">
      Comprobante autorizado electrónicamente por ARCA.
    </p>
  </div>`;
}

async function enviar(args) {
  const requeridos = ["clienteEmail", "cuitEmisor", "emisorRazonSocial", "tipoComprobante", "ptoVta", "nroComprobante", "cae", "vencimientoCae", "total", "neto", "iva"];
  for (const campo of requeridos) {
    if (!args[campo]) error(`Falta el parámetro --${campo}`);
  }
  if (!args.items && !args.itemDescripcion) {
    error("Falta describir el ítem: usá --itemDescripcion (recomendado) o --items como texto libre.");
  }
  if (!NOMBRES_TIPO_COMPROBANTE[args.tipoComprobante]) {
    error(`--tipoComprobante tiene que ser A, B o C (recibí "${args.tipoComprobante}")`);
  }

  const GMAIL_USER = process.env.GMAIL_USER;
  const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    error(
      "Faltan las variables de entorno GMAIL_USER y GMAIL_APP_PASSWORD.\n" +
        "  Mirá el comentario al principio de este archivo para saber cómo conseguir la contraseña de aplicación."
    );
  }

  let nodemailer;
  try {
    nodemailer = require("nodemailer");
  } catch (e) {
    error("Falta instalar la librería nodemailer. Corré: npm install nodemailer");
  }

  const itemsEstructurados =
    args.itemsEstructurados ||
    (args.itemDescripcion
      ? [
          {
            descripcion: args.itemDescripcion,
            cantidad: Number(args.itemCantidad || 1),
            precioUnitario: Number(args.itemPrecioUnitario || args.total / Number(args.itemCantidad || 1)),
            total: Number(args.total),
          },
        ]
      : [{ descripcion: args.items, cantidad: 1, precioUnitario: args.total, total: args.total }]);

  ok("Generando el PDF de la factura...");
  const pdfBuffer = await generarPDFFactura({
    tipoComprobante: args.tipoComprobante,
    ptoVta: args.ptoVta,
    nroComprobante: args.nroComprobante,
    fechaEmision: args.fechaEmision || new Date().toLocaleDateString("es-AR"),
    emisorRazonSocial: args.emisorRazonSocial,
    emisorDomicilio: args.emisorDomicilio || "",
    emisorCuit: args.cuitEmisor,
    emisorCondicionIva: args.emisorCondicionIva || "consumidor_final",
    emisorIIBB: args.emisorIIBB || "",
    emisorInicioActividades: args.emisorInicioActividades || "",
    receptorNombre: args.clienteNombre || null,
    receptorCuit: args.clienteCuit || null,
    receptorCondicionIva: args.clienteCondicionIva || null,
    items: itemsEstructurados,
    neto: args.neto,
    iva: args.iva,
    total: args.total,
    cae: args.cae,
    vencimientoCae: args.vencimientoCae,
  });

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  try {
    await transporter.sendMail({
      from: `"${args.emisorRazonSocial}" <${GMAIL_USER}>`,
      to: args.clienteEmail,
      subject: `${NOMBRES_TIPO_COMPROBANTE[args.tipoComprobante]} N° ${args.nroComprobante} — CAE ${args.cae}`,
      html: armarHTMLMail(args),
      attachments: [
        {
          filename: `factura_${args.ptoVta}_${args.nroComprobante}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    });
  } catch (e) {
    error(`Falló el envío: ${e.message}`);
  }

  ok(`Factura enviada a ${args.clienteEmail}, con el PDF adjunto.`);
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  enviar(args);
}

module.exports = { enviar };
