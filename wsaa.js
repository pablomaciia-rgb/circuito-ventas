#!/usr/bin/env node
/**
 * wsaa.js — Autenticación contra ARCA (WSAA)
 * -------------------------------------------
 * Segundo eslabón del circuito: toma el certificado ya cargado en el
 * onboarding y hace el "apretón de manos" real con los servidores de
 * ARCA para conseguir un token de acceso (válido 12 horas).
 *
 * Este script SÍ necesita conexión a internet real — no va a funcionar
 * en un entorno sandbox sin salida a la web. Corré esto en tu máquina o
 * en Claude Code Desktop.
 *
 * Requiere: openssl instalado en el sistema (viene de fábrica en
 * Mac/Linux; en Windows hay que instalarlo aparte).
 *
 * Uso:
 *   node wsaa.js --cuit 20448884148 --servicio wsfe
 *
 * Guarda el resultado en negocios/<cuit>/token.json — el Motor Central
 * va a leer ese archivo para autenticar cada pedido de CAE, y lo vuelve
 * a generar automáticamente si ya venció (dura 12hs).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const NEGOCIOS_DIR = path.join(__dirname, "negocios");
const WSAA_HOMOLOGACION_HOST = "wsaahomo.afip.gob.ar";
const WSAA_HOMOLOGACION_PATH = "/ws/services/LoginCms";

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

/** Arma el TRA (Ticket de Requerimiento de Acceso): pide acceso a un
 * servicio puntual, con una ventana de validez de 10 minutos a cada lado
 * de "ahora" — así lo pide el manual del WSAA. */
function armarTRA(servicio) {
  const ahora = new Date();
  const generationTime = new Date(ahora.getTime() - 10 * 60 * 1000).toISOString();
  const expirationTime = new Date(ahora.getTime() + 10 * 60 * 1000).toISOString();
  const uniqueId = Math.floor(ahora.getTime() / 1000);

  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${uniqueId}</uniqueId>
    <generationTime>${generationTime}</generationTime>
    <expirationTime>${expirationTime}</expirationTime>
  </header>
  <service>${servicio}</service>
</loginTicketRequest>`;
}

/** Firma el TRA con el certificado y la clave del negocio, usando el
 * binario de openssl (CMS/PKCS7, tal como lo exige ARCA). Devuelve el
 * bloque firmado en base64, listo para meter en el sobre SOAP. */
function firmarTRA(traXml, keyPath, crtPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tra-"));
  const traPath = path.join(tmpDir, "tra.xml");
  const cmsPath = path.join(tmpDir, "tra.cms");
  fs.writeFileSync(traPath, traXml);

  try {
    execFileSync("openssl", [
      "smime", "-sign",
      "-signer", crtPath,
      "-inkey", keyPath,
      "-outform", "DER",
      "-nodetach",
      "-in", traPath,
      "-out", cmsPath,
    ]);
  } catch (e) {
    error(`Falló la firma con OpenSSL: ${e.message}`);
  }

  const cms = fs.readFileSync(cmsPath);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return cms.toString("base64");
}

/** Envuelve el CMS firmado en el sobre SOAP que espera el WSAA y hace
 * el POST real contra ARCA. */
function llamarWSAA(cmsBase64) {
  const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body>
    <wsaa:loginCms>
      <wsaa:in0>${cmsBase64}</wsaa:in0>
    </wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;

  const options = {
    hostname: WSAA_HOMOLOGACION_HOST,
    path: WSAA_HOMOLOGACION_PATH,
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "Content-Length": Buffer.byteLength(soapBody),
      SOAPAction: "",
    },
    timeout: 15000,
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout — no hubo respuesta de ARCA en 15 segundos. Revisá tu conexión a internet."));
    });
    req.on("error", reject);
    req.write(soapBody);
    req.end();
  });
}

function extraerTokenYSign(respuestaSoap) {
  // La respuesta trae el loginTicketResponse "escapado" adentro del XML SOAP
  // (&lt; en vez de <). Lo desescapamos antes de buscar token/sign.
  const desescapado = respuestaSoap
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

  const token = desescapado.match(/<token>([\s\S]*?)<\/token>/);
  const sign = desescapado.match(/<sign>([\s\S]*?)<\/sign>/);
  const expirationTime = desescapado.match(/<expirationTime>([\s\S]*?)<\/expirationTime>/);
  const faultstring = respuestaSoap.match(/<faultstring>([\s\S]*?)<\/faultstring>/);

  if (faultstring) {
    return { errorArca: faultstring[1] };
  }
  if (!token || !sign) {
    return { errorArca: "No se pudo extraer token/sign de la respuesta — revisar la respuesta cruda de ARCA." };
  }
  return { token: token[1], sign: sign[1], expirationTime: expirationTime ? expirationTime[1] : null };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { cuit, servicio = "wsfe" } = args;

  if (!cuit) error("Uso: node wsaa.js --cuit <cuit> [--servicio wsfe]");

  const dir = path.join(NEGOCIOS_DIR, cuit);
  const keyPath = path.join(dir, "certs", "certificado.key");
  const crtPath = path.join(dir, "certs", "certificado.crt");

  if (!fs.existsSync(keyPath) || !fs.existsSync(crtPath)) {
    error(`No encuentro el certificado del negocio ${cuit}. Corré primero "onboarding.js certificado".`);
  }

  console.log(`Armando el TRA para el servicio "${servicio}"...`);
  const tra = armarTRA(servicio);

  console.log("Firmando el TRA con el certificado del negocio...");
  const cmsBase64 = firmarTRA(tra, keyPath, crtPath);

  console.log(`Conectando con ARCA (${WSAA_HOMOLOGACION_HOST})...`);
  let respuesta;
  try {
    respuesta = await llamarWSAA(cmsBase64);
  } catch (e) {
    error(`No se pudo conectar con ARCA: ${e.message}\n  Este script necesita internet real — no funciona en un sandbox sin salida a la web.`);
  }

  if (respuesta.status !== 200) {
    console.error(`✗ ARCA respondió con estado HTTP ${respuesta.status}`);
    console.error(respuesta.body.slice(0, 1000));
    process.exit(1);
  }

  const resultado = extraerTokenYSign(respuesta.body);
  if (resultado.errorArca) {
    error(`ARCA rechazó la solicitud: ${resultado.errorArca}`);
  }

  const tokenPath = path.join(dir, `token_${servicio}.json`);
  fs.writeFileSync(
    tokenPath,
    JSON.stringify(
      {
        servicio,
        token: resultado.token,
        sign: resultado.sign,
        expirationTime: resultado.expirationTime,
        obtenidoEn: new Date().toISOString(),
      },
      null,
      2
    ),
    { mode: 0o600 }
  );

  ok(`Autenticación exitosa contra ARCA para el servicio "${servicio}".`);
  console.log(`  Token guardado en negocios/${cuit}/token_${servicio}.json`);
  console.log(`  Vence: ${resultado.expirationTime} (dura 12hs, después hay que pedir uno nuevo)`);
  console.log("  Próximo paso: usar este token+sign para pedir el primer CAE de prueba contra wsfe.");
}

main();
