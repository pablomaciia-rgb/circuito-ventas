#!/usr/bin/env node
/**
 * wsfe.js — Facturación electrónica contra ARCA (WSFE)
 * -------------------------------------------------------
 * Tercer eslabón del circuito: usa el token+sign que dejó wsaa.js para
 * consultar el último comprobante autorizado y pedir el CAE de una
 * factura nueva.
 *
 * Requiere: negocios/<cuit>/token_wsfe.json vigente (corré wsaa.js si
 * no existe o si venció — dura 12hs).
 *
 * Este script SÍ necesita conexión a internet real, igual que wsaa.js.
 *
 * Uso:
 *   node wsfe.js --cuit 20448884148 [--producto "Nombre"] [--cantidad 1]
 *   node wsfe.js --cuit 20448884148 --producto "Nombre" \
 *     --clienteCuit 20111111112 --clienteCondicionIva responsable_inscripto
 *
 * Si no se pasa --producto, usa el primero de negocios/<cuit>/productos.json.
 *
 * Si se pasan --clienteCuit y --clienteCondicionIva, el comprobante se
 * arma con ese cliente como receptor identificado (DocTipo 80 = CUIT) en
 * vez de Consumidor Final genérico. Sin esos flags, el comportamiento es
 * exactamente el mismo que antes.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const NEGOCIOS_DIR = path.join(__dirname, "negocios");
const WSFE_HOMOLOGACION_HOST = "wswhomo.afip.gov.ar";
const WSFE_HOMOLOGACION_PATH = "/wsfev1/service.asmx";
const WSFE_NS = "http://ar.gov.afip.dif.FEV1/";

// Alícuotas de IVA -> Id que espera ARCA (tabla fija del WSFE).
const ALICUOTA_ID = { 0: 3, 10.5: 4, 21: 5, 27: 6, 5: 8, 2.5: 9 };

// Consumidor final sin identificar.
const DOC_TIPO_CONSUMIDOR_FINAL = 99;
const DOC_NRO_CONSUMIDOR_FINAL = 0;
// Receptor identificado por CUIT.
const DOC_TIPO_CUIT = 80;

// Condición frente al IVA del receptor (RG 5616/2024), por condición de IVA.
const COND_IVA_RECEPTOR_ID = {
  responsable_inscripto: 1,
  exento: 4,
  consumidor_final: 5,
  monotributo: 6,
};
const CONDICIONES_IVA_RECEPTOR_VALIDAS = Object.keys(COND_IVA_RECEPTOR_ID);

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

function extraerValor(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
}

function extraerTodos(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

/** Redondea a 2 decimales evitando el ruido de coma flotante. */
function redondear(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Fecha en formato AAAAMMDD, tal como lo pide ARCA. */
function fechaAfip(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/**
 * Valida el CUIT con el algoritmo de dígito verificador de ARCA (módulo 11).
 * Misma lógica que onboarding.js — se duplica acá para no depender de otro
 * archivo en tiempo de ejecución.
 */
function validarCuit(cuit) {
  if (!/^\d{11}$/.test(cuit)) return false;
  const digitos = cuit.split("").map(Number);
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((acc, peso, i) => acc + peso * digitos[i], 0);
  const resto = suma % 11;
  let verificador = 11 - resto;
  if (verificador === 11) verificador = 0;
  if (verificador === 10) return false;
  return verificador === digitos[10];
}

/**
 * Grupo "A" según el campo Cmp_Clase que devuelve el método ARCA
 * FEParamGetCondicionIvaReceptor (RG 5616/2024): estas condiciones de IVA
 * del receptor solo admiten comprobantes clase A (nunca B). Confirmado
 * contra homologación el 2026-08-15: Responsable Inscripto y Monotributo
 * tienen Cmp_Clase "A/ALEY/C"; Exento y Consumidor Final NO están en este
 * grupo (su Cmp_Clase es "B/C" y "C/49" respectivamente).
 */
const GRUPO_RECEPTOR_FACTURA_A = new Set(["responsable_inscripto", "monotributo"]);

/**
 * Determina el tipo de comprobante según la condición de IVA del negocio
 * emisor y, si el receptor está identificado, el grupo al que pertenece
 * su condición de IVA:
 *   - Emisor Responsable Inscripto + receptor del grupo A (RI o Monotributo) -> Factura A
 *   - Emisor Responsable Inscripto + cualquier otro receptor (o sin identificar) -> Factura B
 *   - Emisor Monotributo/Exento/Consumidor Final (no discrimina IVA) -> Factura C
 */
function tipoComprobante(condicionIvaEmisor, condicionIvaReceptor) {
  if (condicionIvaEmisor !== "responsable_inscripto") return 11; // Factura C
  if (condicionIvaReceptor && GRUPO_RECEPTOR_FACTURA_A.has(condicionIvaReceptor)) return 1; // Factura A
  return 6; // Factura B
}

function discrimina(cbteTipo) {
  return cbteTipo === 6 || cbteTipo === 1; // Factura A o B discriminan IVA
}

const LETRA_TIPO_COMPROBANTE = { 1: "A", 6: "B", 11: "C" };

function cargarJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function llamarWSFE(soapAction, bodyXml) {
  const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${WSFE_NS}">
  <soapenv:Header/>
  <soapenv:Body>
    ${bodyXml}
  </soapenv:Body>
</soapenv:Envelope>`;

  const options = {
    hostname: WSFE_HOMOLOGACION_HOST,
    path: WSFE_HOMOLOGACION_PATH,
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "Content-Length": Buffer.byteLength(soapBody),
      SOAPAction: `${WSFE_NS}${soapAction}`,
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

function chequearFault(respuestaSoap) {
  const faultstring = respuestaSoap.match(/<faultstring>([\s\S]*?)<\/faultstring>/);
  if (faultstring) error(`ARCA rechazó la solicitud: ${faultstring[1]}`);
}

/** Errores de negocio de WSFE (autenticación ok, pero el pedido es inválido). */
function chequearErrores(respuestaSoap) {
  const errores = extraerTodos(respuestaSoap, "Err");
  if (errores.length === 0) return;
  const detalle = errores
    .map((e) => `Code ${extraerValor(e, "Code") || "?"}: ${extraerValor(e, "Msg") || "?"}`)
    .join(" | ");
  error(`ARCA devolvió errores: ${detalle}`);
}

async function consultarUltimoAutorizado(auth, ptoVta, cbteTipo) {
  const body = `<ar:FECompUltimoAutorizado>
      <ar:Auth>
        <ar:Token>${auth.token}</ar:Token>
        <ar:Sign>${auth.sign}</ar:Sign>
        <ar:Cuit>${auth.cuit}</ar:Cuit>
      </ar:Auth>
      <ar:PtoVta>${ptoVta}</ar:PtoVta>
      <ar:CbteTipo>${cbteTipo}</ar:CbteTipo>
    </ar:FECompUltimoAutorizado>`;

  let respuesta;
  try {
    respuesta = await llamarWSFE("FECompUltimoAutorizado", body);
  } catch (e) {
    error(`No se pudo conectar con ARCA: ${e.message}\n  Este script necesita internet real — no funciona en un sandbox sin salida a la web.`);
  }
  if (respuesta.status !== 200) {
    console.error(`✗ ARCA respondió con estado HTTP ${respuesta.status}`);
    console.error(respuesta.body.slice(0, 1000));
    process.exit(1);
  }
  chequearFault(respuesta.body);
  chequearErrores(respuesta.body);

  const cbteNro = extraerValor(respuesta.body, "CbteNro");
  if (cbteNro === null) error("No se pudo leer CbteNro de la respuesta de FECompUltimoAutorizado.");
  return Number(cbteNro);
}

async function solicitarCAE(auth, ptoVta, cbteTipo, detalle) {
  const ivaXml = detalle.iva
    ? `<ar:Iva>
              <ar:AlicIva>
                <ar:Id>${detalle.iva.id}</ar:Id>
                <ar:BaseImp>${detalle.iva.baseImp}</ar:BaseImp>
                <ar:Importe>${detalle.iva.importe}</ar:Importe>
              </ar:AlicIva>
            </ar:Iva>`
    : "";

  const body = `<ar:FECAESolicitar>
      <ar:Auth>
        <ar:Token>${auth.token}</ar:Token>
        <ar:Sign>${auth.sign}</ar:Sign>
        <ar:Cuit>${auth.cuit}</ar:Cuit>
      </ar:Auth>
      <ar:FeCAEReq>
        <ar:FeCabReq>
          <ar:CantReg>1</ar:CantReg>
          <ar:PtoVta>${ptoVta}</ar:PtoVta>
          <ar:CbteTipo>${cbteTipo}</ar:CbteTipo>
        </ar:FeCabReq>
        <ar:FeDetReq>
          <ar:FECAEDetRequest>
            <ar:Concepto>1</ar:Concepto>
            <ar:DocTipo>${detalle.docTipo}</ar:DocTipo>
            <ar:DocNro>${detalle.docNro}</ar:DocNro>
            <ar:CbteDesde>${detalle.cbteNro}</ar:CbteDesde>
            <ar:CbteHasta>${detalle.cbteNro}</ar:CbteHasta>
            <ar:CbteFch>${detalle.cbteFch}</ar:CbteFch>
            <ar:ImpTotal>${detalle.impTotal}</ar:ImpTotal>
            <ar:ImpTotConc>0</ar:ImpTotConc>
            <ar:ImpNeto>${detalle.impNeto}</ar:ImpNeto>
            <ar:ImpOpEx>0</ar:ImpOpEx>
            <ar:ImpIVA>${detalle.impIva}</ar:ImpIVA>
            <ar:ImpTrib>0</ar:ImpTrib>
            <ar:MonId>PES</ar:MonId>
            <ar:MonCotiz>1</ar:MonCotiz>
            <ar:CondicionIVAReceptorId>${detalle.condicionIvaReceptorId}</ar:CondicionIVAReceptorId>
            ${ivaXml}
          </ar:FECAEDetRequest>
        </ar:FeDetReq>
      </ar:FeCAEReq>
    </ar:FECAESolicitar>`;

  let respuesta;
  try {
    respuesta = await llamarWSFE("FECAESolicitar", body);
  } catch (e) {
    error(`No se pudo conectar con ARCA: ${e.message}`);
  }
  if (respuesta.status !== 200) {
    console.error(`✗ ARCA respondió con estado HTTP ${respuesta.status}`);
    console.error(respuesta.body.slice(0, 1000));
    process.exit(1);
  }
  chequearFault(respuesta.body);
  chequearErrores(respuesta.body);

  const resultado = extraerValor(respuesta.body, "Resultado");
  const cae = extraerValor(respuesta.body, "CAE");
  const caeFchVto = extraerValor(respuesta.body, "CAEFchVto");
  const observaciones = extraerTodos(respuesta.body, "Msg");

  if (resultado !== "A" || !cae) {
    error(
      `ARCA no autorizó el comprobante (Resultado: ${resultado || "?"}).` +
        (observaciones.length ? ` Observaciones: ${observaciones.join(" | ")}` : "")
    );
  }

  return { cae, caeFchVto, observaciones };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { cuit, producto: nombreProducto, cantidad = "1", clienteCuit, clienteCondicionIva } = args;

  if (!cuit) error("Uso: node wsfe.js --cuit <cuit> [--producto \"Nombre\"] [--cantidad 1] [--clienteCuit <cuit>] [--clienteCondicionIva <condición>]");

  if ((clienteCuit && !clienteCondicionIva) || (!clienteCuit && clienteCondicionIva)) {
    error("--clienteCuit y --clienteCondicionIva van juntos: pasá los dos o ninguno.");
  }
  if (clienteCuit) {
    if (!validarCuit(clienteCuit)) error(`El CUIT del cliente "${clienteCuit}" no es válido (falló el dígito verificador).`);
    if (!CONDICIONES_IVA_RECEPTOR_VALIDAS.includes(clienteCondicionIva)) {
      error(`--clienteCondicionIva "${clienteCondicionIva}" no reconocida. Usar una de: ${CONDICIONES_IVA_RECEPTOR_VALIDAS.join(", ")}`);
    }
  }

  const dir = path.join(NEGOCIOS_DIR, cuit);
  const configPath = path.join(dir, "config.json");
  const productosPath = path.join(dir, "productos.json");
  const tokenPath = path.join(dir, "token_wsfe.json");

  if (!fs.existsSync(configPath)) error(`No existe un negocio con CUIT ${cuit}.`);
  if (!fs.existsSync(tokenPath)) {
    error(`No encuentro negocios/${cuit}/token_wsfe.json. Corré primero "node wsaa.js --cuit ${cuit} --servicio wsfe".`);
  }

  const config = cargarJSON(configPath);
  const productos = fs.existsSync(productosPath) ? cargarJSON(productosPath) : [];
  const token = cargarJSON(tokenPath);

  if (new Date(token.expirationTime) <= new Date()) {
    error(`El token de negocios/${cuit}/token_wsfe.json venció (${token.expirationTime}). Corré de nuevo "node wsaa.js --cuit ${cuit} --servicio wsfe".`);
  }

  if (productos.length === 0) {
    error(`No hay productos cargados para el negocio ${cuit}. Corré "node onboarding.js productos --cuit ${cuit} --archivo <productos.json>" primero.`);
  }

  const producto = nombreProducto ? productos.find((p) => p.nombre === nombreProducto) : productos[0];
  if (!producto) error(`No encontré el producto "${nombreProducto}" en negocios/${cuit}/productos.json.`);

  const cant = Number(cantidad);
  if (!Number.isFinite(cant) || cant <= 0) error("--cantidad debe ser un número positivo.");

  const receptorIdentificado = clienteCuit
    ? { docTipo: DOC_TIPO_CUIT, docNro: clienteCuit, condicionIvaReceptorId: COND_IVA_RECEPTOR_ID[clienteCondicionIva] }
    : { docTipo: DOC_TIPO_CONSUMIDOR_FINAL, docNro: DOC_NRO_CONSUMIDOR_FINAL, condicionIvaReceptorId: COND_IVA_RECEPTOR_ID.consumidor_final };

  const auth = { token: token.token, sign: token.sign, cuit: config.cuit };
  const ptoVta = config.puntoVenta;
  const cbteTipo = tipoComprobante(config.condicionIva, clienteCondicionIva);

  console.log(`Consultando último comprobante autorizado (PtoVta ${ptoVta}, tipo ${cbteTipo})...`);
  const ultimo = await consultarUltimoAutorizado(auth, ptoVta, cbteTipo);
  const proximoNro = ultimo + 1;
  ok(`Último autorizado: ${ultimo}. Este comprobante será el N° ${proximoNro}.`);

  // El precio del producto es el monto final que paga el cliente, IVA
  // incluido. Se descompone en neto + IVA para el pedido a ARCA.
  const impTotal = redondear(producto.precio * cant);
  let detalle;
  if (discrimina(cbteTipo)) {
    const alicuota = producto.alicuotaIva ?? 21;
    const alicIvaId = ALICUOTA_ID[alicuota];
    if (!alicIvaId) error(`Alícuota de IVA "${alicuota}" no reconocida por ARCA (válidas: ${Object.keys(ALICUOTA_ID).join(", ")}).`);

    const impNeto = redondear(impTotal / (1 + alicuota / 100));
    const impIva = redondear(impTotal - impNeto);
    detalle = {
      ...receptorIdentificado,
      cbteNro: proximoNro,
      cbteFch: fechaAfip(),
      impTotal,
      impNeto,
      impIva,
      iva: { id: alicIvaId, baseImp: impNeto, importe: impIva },
    };
  } else {
    // Factura C: no discrimina IVA — el neto es igual al total.
    detalle = {
      ...receptorIdentificado,
      cbteNro: proximoNro,
      cbteFch: fechaAfip(),
      impTotal,
      impNeto: impTotal,
      impIva: 0,
      iva: null,
    };
  }

  const descReceptor = clienteCuit ? `CUIT ${clienteCuit} (${clienteCondicionIva})` : "consumidor final";
  console.log(`Armando factura: ${cant} x "${producto.nombre}" — total $${impTotal.toFixed(2)} (${descReceptor})...`);
  console.log("Solicitando CAE a ARCA...");
  const { cae, caeFchVto } = await solicitarCAE(auth, ptoVta, cbteTipo, detalle);

  fs.writeFileSync(
    path.join(dir, "ultima_factura.json"),
    JSON.stringify(
      {
        tipoComprobante: LETRA_TIPO_COMPROBANTE[cbteTipo],
        ptoVta,
        nroComprobante: proximoNro,
        cae,
        vencimientoCae: caeFchVto,
        total: impTotal,
        neto: detalle.impNeto,
        iva: detalle.impIva,
      },
      null,
      2
    )
  );

  ok(`CAE obtenido para el comprobante N° ${proximoNro} (PtoVta ${ptoVta}, tipo ${cbteTipo}).`);
  console.log(`  CAE: ${cae}`);
  console.log(`  Vencimiento del CAE: ${caeFchVto}`);
  console.log(`  Total facturado: $${impTotal.toFixed(2)} (neto $${detalle.impNeto.toFixed(2)} + IVA $${detalle.impIva.toFixed(2)})`);
}

main();
