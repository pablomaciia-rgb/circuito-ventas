#!/usr/bin/env node
/**
 * conectores/planilla.js — Conector de Planilla (Google Sheets)
 * ----------------------------------------------------------------
 * Tercer eslabón del circuito: revisa una planilla de Google Sheets
 * y factura automáticamente cada fila nueva, llamando al wsfe.js
 * que ya está funcionando.
 *
 * Diseño elegido a propósito: en vez de que la planilla "avise" a este
 * script (lo que necesitaría un servidor público), este script
 * PREGUNTA cada tanto "¿hay algo nuevo?" — así no hace falta exponer
 * nada a internet ni pagar hosting.
 *
 * ---- Cómo preparar la planilla ----
 * 1. En Google Sheets, la primera fila tiene que ser encabezados:
 *      cliente | producto | cantidad | email
 * 2. Archivo → Compartir → Publicar en la Web → elegir la hoja →
 *    formato "Valores separados por comas (.csv)" → Publicar.
 * 3. Copiar la URL que te da (termina en "output=csv") y pasarla acá
 *    con --url.
 *
 * ---- Uso ----
 *   node conectores/planilla.js --cuit 20448884148 --url "<url del csv>"
 *   node conectores/planilla.js --cuit 20448884148 --url "<url>" --watch
 *
 * Sin --watch corre una sola pasada (bueno para probar o para cron).
 * Con --watch queda corriendo y revisa cada 30 segundos (Ctrl+C para
 * parar).
 *
 * Si la fila tiene email, después de facturar dispara el envío
 * automático de la factura por mail (enviarFactura.js). Si no hay
 * email, factura igual pero no manda nada — la venta nunca se pierde
 * por falta de este dato.
 *
 * ---- Escritura de vuelta en la planilla (opcional) ----
 * Si pasás --spreadsheetId (el ID real de la hoja, de la URL de
 * edición — no el link publicado) y la planilla tiene una columna
 * "facturado", el conector marca "Sí" ahí después de facturar, y
 * también completa "cae" y "total" si esas columnas existen. Requiere
 * credenciales-google-sheets.json (cuenta de servicio con permiso de
 * Editor en la hoja real). Sin --spreadsheetId, el conector sigue
 * funcionando igual que antes, solo que no escribe nada de vuelta.
 *
 *   node conectores/planilla.js --cuit 20448884148 --url "<url csv>" \
 *     --spreadsheetId "1Z5RfcvaANBHgwb9k7ritEsqVTG9jIDu-1wQTaByofSY" [--gid 0]
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");
const { buscarOCrear } = require("../clientes");
const { obtenerTituloHoja, escribirFila } = require("../sheetsAPI");

const NEGOCIOS_DIR = path.join(__dirname, "..", "negocios");
const WSFE_SCRIPT = path.join(__dirname, "..", "wsfe.js");
const POLL_MS = 30 * 1000;

function error(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`✓ ${msg}`);
}
function log(msg) {
  console.log(`  ${msg}`);
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

/** Parser de CSV simple: soporta comillas y comas dentro de campos
 * entrecomillados, que es lo mínimo que exporta Google Sheets. No
 * pretende cubrir todos los casos raros de CSV, solo lo que Sheets
 * genera.
 *
 * Devuelve { fila, filaSheet } por cada fila — filaSheet es el número
 * de fila real en la hoja (1-based, contando el encabezado), necesario
 * para escribir en la celda correcta al marcar "facturado". No alcanza
 * con el índice dentro del array: si hay filas en blanco en el medio,
 * se filtran acá abajo y el índice dejaría de coincidir con la hoja
 * real. */
function parseCSV(texto) {
  const filas = [];
  let fila = [];
  let campo = "";
  let entreComillas = false;

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    const siguiente = texto[i + 1];

    if (entreComillas) {
      if (c === '"' && siguiente === '"') {
        campo += '"';
        i++;
      } else if (c === '"') {
        entreComillas = false;
      } else {
        campo += c;
      }
    } else {
      if (c === '"') {
        entreComillas = true;
      } else if (c === ",") {
        fila.push(campo);
        campo = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && siguiente === "\n") i++;
        fila.push(campo);
        filas.push(fila);
        fila = [];
        campo = "";
      } else {
        campo += c;
      }
    }
  }
  if (campo.length > 0 || fila.length > 0) {
    fila.push(campo);
    filas.push(fila);
  }
  return filas
    .map((f, i) => ({ fila: f, filaSheet: i + 1 }))
    .filter(({ fila: f }) => f.some((c) => c.trim() !== ""));
}

function descargarCSV(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          return resolve(descargarCSV(res.headers.location));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`La planilla respondió con estado HTTP ${res.statusCode}. ¿Está publicada como CSV?`));
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

function filaAObjeto(encabezados, fila) {
  const obj = {};
  encabezados.forEach((h, i) => {
    obj[h.trim().toLowerCase()] = (fila[i] || "").trim();
  });
  return obj;
}

/** Identificador único y estable de una fila, para no facturarla dos
 * veces. Se arma solo con cliente + producto + cantidad — no con la
 * fila cruda completa — para que agregar una columna nueva a la
 * planilla (como "email") no le cambie la huella a las filas ya
 * procesadas y las vuelva a facturar por error. Si alguien edita el
 * cliente, el producto o la cantidad de una fila ya procesada, sí se
 * trata como "nueva" a propósito (mejor facturar de más en
 * homologación que perderse un cambio real). */
function idDeFila(cliente, producto, cantidad) {
  return [cliente, producto, cantidad].join("|");
}

function cargarProcesadas(cuit) {
  const p = path.join(NEGOCIOS_DIR, cuit, "planilla_procesadas.json");
  if (!fs.existsSync(p)) return { ids: [], registro: [] };
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function guardarProcesadas(cuit, estado) {
  const p = path.join(NEGOCIOS_DIR, cuit, "planilla_procesadas.json");
  fs.writeFileSync(p, JSON.stringify(estado, null, 2));
}

const ENVIAR_FACTURA_SCRIPT = path.join(__dirname, "..", "enviarFactura.js");

function cargarJSON(ruta, porDefecto) {
  try {
    return JSON.parse(fs.readFileSync(ruta, "utf8"));
  } catch (e) {
    return porDefecto;
  }
}

/**
 * Dispara enviarFactura.js con los datos de la última factura que
 * acaba de generar wsfe.js. Depende de que wsfe.js escriba
 * negocios/<cuit>/ultima_factura.json después de cada CAE exitoso
 * (tipoComprobante, ptoVta, nroComprobante, cae, vencimientoCae,
 * total, neto, iva) — si ese archivo no existe todavía, el envío se
 * salta con un aviso claro en vez de romper todo el conector.
 */
function enviarFacturaAlCliente(cuit, email, cliente, producto, cantidad, salidaWsfe) {
  const rutaUltimaFactura = path.join(NEGOCIOS_DIR, cuit, "ultima_factura.json");
  const factura = cargarJSON(rutaUltimaFactura, null);
  if (!factura) {
    return {
      exito: false,
      salida:
        `No encuentro negocios/${cuit}/ultima_factura.json — wsfe.js todavía no guarda ahí los datos de la factura.\n` +
        `Hace falta actualizar wsfe.js para que, después de cada CAE exitoso, escriba ese archivo con:\n` +
        `{ tipoComprobante, ptoVta, nroComprobante, cae, vencimientoCae, total, neto, iva }`,
    };
  }

  const config = cargarJSON(path.join(NEGOCIOS_DIR, cuit, "config.json"), {});
  const productos = cargarJSON(path.join(NEGOCIOS_DIR, cuit, "productos.json"), []);
  const productoInfo = productos.find((p) => p.nombre.toLowerCase() === String(producto).toLowerCase());
  const precioUnitario = productoInfo ? productoInfo.precio : Number(factura.total) / Number(cantidad || 1);

  const args = [
    ENVIAR_FACTURA_SCRIPT,
    "--clienteEmail", email,
    "--clienteNombre", cliente,
    "--cuitEmisor", cuit,
    "--emisorRazonSocial", config.razonSocial || "",
    "--emisorCondicionIva", config.condicionIva || "consumidor_final",
    "--tipoComprobante", factura.tipoComprobante,
    "--ptoVta", String(factura.ptoVta),
    "--nroComprobante", String(factura.nroComprobante),
    "--cae", String(factura.cae),
    "--vencimientoCae", String(factura.vencimientoCae),
    "--total", String(factura.total),
    "--neto", String(factura.neto),
    "--iva", String(factura.iva),
    "--itemDescripcion", producto,
    "--itemCantidad", String(cantidad || 1),
    "--itemPrecioUnitario", String(precioUnitario),
  ];

  try {
    const salida = execFileSync("node", args, { encoding: "utf8" });
    return { exito: true, salida };
  } catch (e) {
    return { exito: false, salida: (e.stdout || "") + (e.stderr || e.message) };
  }
}

function facturar(cuit, producto, cantidad, datosCliente) {
  const args = ["--cuit", cuit];
  if (producto) args.push("--producto", producto);
  if (cantidad) args.push("--cantidad", String(cantidad));

  if (datosCliente && datosCliente.estado === "completo") {
    args.push("--clienteCuit", datosCliente.clienteCuit);
    args.push("--clienteCondicionIva", datosCliente.condicionIva);
  }

  try {
    const salida = execFileSync("node", [WSFE_SCRIPT, ...args], { encoding: "utf8" });
    return { exito: true, salida };
  } catch (e) {
    return { exito: false, salida: (e.stdout || "") + (e.stderr || e.message) };
  }
}

async function unaPasada(cuit, url, spreadsheetId, gid) {
  log(`Revisando planilla...`);
  let csv;
  try {
    csv = await descargarCSV(url);
  } catch (e) {
    error(`No se pudo descargar la planilla: ${e.message}`);
  }

  const filas = parseCSV(csv);
  if (filas.length === 0) {
    log("La planilla está vacía.");
    return;
  }

  const encabezados = filas[0].fila;
  const datos = filas.slice(1);

  const colCliente = encabezados.findIndex((h) => h.trim().toLowerCase() === "cliente");
  const colProducto = encabezados.findIndex((h) => h.trim().toLowerCase() === "producto");
  const colCantidad = encabezados.findIndex((h) => h.trim().toLowerCase() === "cantidad");
  const colEmail = encabezados.findIndex((h) => h.trim().toLowerCase() === "email");
  const colFacturado = encabezados.findIndex((h) => h.trim().toLowerCase() === "facturado");
  const colCae = encabezados.findIndex((h) => h.trim().toLowerCase() === "cae");
  const colTotal = encabezados.findIndex((h) => h.trim().toLowerCase() === "total");

  if (colProducto === -1) {
    error('La planilla necesita una columna "producto" en la primera fila. Encabezados encontrados: ' + encabezados.join(", "));
  }
  if (colEmail === -1) {
    log('Aviso: no hay columna "email" en la planilla — las facturas no se van a poder enviar automáticamente hasta que la agregues.');
  }

  let tituloHoja = null;
  if (spreadsheetId) {
    if (colFacturado === -1) {
      log('Aviso: pasaste --spreadsheetId pero no hay columna "facturado" en la planilla — no voy a poder marcar el estado ahí.');
    } else {
      try {
        tituloHoja = await obtenerTituloHoja(spreadsheetId, gid);
      } catch (e) {
        log(`Aviso: no pude conectar con la Google Sheets API para escribir en la hoja (${e.message}). Sigo facturando, pero sin marcar el estado ahí.`);
      }
    }
  }

  const estado = cargarProcesadas(cuit);
  const yaProcesadas = new Set(estado.ids);

  let nuevas = 0;
  for (const { fila, filaSheet } of datos) {
    const cliente = colCliente !== -1 ? fila[colCliente] : "(sin especificar)";
    const producto = fila[colProducto];
    const cantidad = colCantidad !== -1 ? fila[colCantidad] || "1" : "1";
    const email = colEmail !== -1 ? (fila[colEmail] || "").trim() : "";

    const id = idDeFila(cliente, producto, cantidad);
    if (yaProcesadas.has(id)) continue;

    nuevas++;

    log(`Fila nueva: cliente="${cliente}", producto="${producto}", cantidad=${cantidad}`);

    if (!producto) {
      log("  ✗ Salteada: no tiene producto.");
      estado.ids.push(id);
      estado.registro.push({ fecha: new Date().toISOString(), cliente, producto, cantidad, resultado: "salteada_sin_producto" });
      continue;
    }

    const { cliente: datosCliente, esNuevo } = buscarOCrear(cuit, cliente, email || undefined);
    if (esNuevo) {
      log(`  ⚠ Cliente nuevo — se agregó al padrón como pendiente de completar (CUIT, condición de IVA).`);
    } else if (datosCliente.estado === "pendiente") {
      log(`  ⚠ Cliente ya conocido pero todavía pendiente de completar datos.`);
    } else {
      log(`  Cliente identificado: ${datosCliente.condicionIva}, CUIT ${datosCliente.clienteCuit}.`);
    }

    const resultado = facturar(cuit, producto, cantidad, datosCliente);
    if (resultado.exito) {
      const ultimaFactura = cargarJSON(path.join(NEGOCIOS_DIR, cuit, "ultima_factura.json"), null);
      const caeMatch = resultado.salida.match(/CAE:\s*(\d+)/);
      const cae = ultimaFactura ? ultimaFactura.cae : caeMatch ? caeMatch[1] : null;
      const total = ultimaFactura ? ultimaFactura.total : null;
      ok(`  Facturado — ${cae ? "CAE " + cae : "ver detalle abajo"}`);

      const entradaRegistro = {
        fecha: new Date().toISOString(),
        cliente,
        producto,
        cantidad,
        resultado: "facturado",
        cae,
        clientePendiente: datosCliente.estado !== "completo",
      };

      if (tituloHoja) {
        const valoresPorColumna = { [colFacturado]: "Sí" };
        if (colCae !== -1 && cae) valoresPorColumna[colCae] = cae;
        if (colTotal !== -1 && total !== null) valoresPorColumna[colTotal] = total;
        try {
          await escribirFila(spreadsheetId, tituloHoja, filaSheet, valoresPorColumna);
          log("  Planilla actualizada (facturado/cae/total).");
        } catch (e) {
          console.error(`  ✗ Se facturó bien pero no pude escribir el estado en la planilla: ${e.message}`);
        }
      }

      const emailDestino = datosCliente.email || email;
      if (emailDestino) {
        const envio = enviarFacturaAlCliente(cuit, emailDestino, cliente, producto, cantidad, resultado.salida);
        if (envio.exito) {
          ok(`  Factura enviada por mail a ${emailDestino}`);
          entradaRegistro.envioMail = "exitoso";
        } else {
          console.error(`  ✗ La factura se autorizó pero el envío por mail falló:`);
          console.error(envio.salida.split("\n").map((l) => "    " + l).join("\n"));
          entradaRegistro.envioMail = "error";
          entradaRegistro.envioMailDetalle = envio.salida.slice(0, 500);
        }
      } else {
        log("  (sin email para este cliente — la factura no se envió, solo quedó autorizada por ARCA)");
        entradaRegistro.envioMail = "sin_email";
      }

      estado.registro.push(entradaRegistro);
    } else {
      console.error(`  ✗ Falló la facturación de esta fila:`);
      console.error(resultado.salida.split("\n").map((l) => "    " + l).join("\n"));
      estado.registro.push({ fecha: new Date().toISOString(), cliente, producto, cantidad, resultado: "error", detalle: resultado.salida.slice(0, 500) });
    }

    estado.ids.push(id);
    guardarProcesadas(cuit, estado);
  }

  if (nuevas === 0) {
    log("No hay filas nuevas.");
  } else {
    ok(`Procesadas ${nuevas} fila(s) nueva(s).`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { cuit, url, watch, spreadsheetId, gid = "0" } = args;

  if (!cuit || !url) {
    error('Uso: node conectores/planilla.js --cuit <cuit> --url "<url csv publicada>" [--spreadsheetId <id>] [--gid <gid>] [--watch]');
  }
  if (!fs.existsSync(path.join(NEGOCIOS_DIR, cuit))) {
    error(`No existe un negocio con CUIT ${cuit}. Corré primero el onboarding.`);
  }
  if (!fs.existsSync(WSFE_SCRIPT)) {
    error(`No encuentro wsfe.js en ${WSFE_SCRIPT} — tiene que estar al lado de la carpeta conectores/.`);
  }

  await unaPasada(cuit, url, spreadsheetId, gid);

  if (watch) {
    ok(`Quedando en modo watch — reviso cada ${POLL_MS / 1000} segundos. Ctrl+C para salir.`);
    setInterval(() => unaPasada(cuit, url, spreadsheetId, gid), POLL_MS);
  }
}

main();
