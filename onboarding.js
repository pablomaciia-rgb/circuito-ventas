#!/usr/bin/env node
/**
 * onboarding.js — Alta y onboarding de negocios
 * -----------------------------------------------
 * Primer eslabón del circuito: registra un negocio nuevo antes de que
 * el Motor Central pueda facturar en su nombre.
 *
 * Cada negocio queda aislado en su propia carpeta (multi-tenant):
 *   negocios/<cuit>/config.json      -> razón social, condición IVA, punto de venta
 *   negocios/<cuit>/productos.json   -> lista inicial de productos y precios
 *   negocios/<cuit>/certs/           -> certificado.key y certificado.crt (permisos 600)
 *
 * Comandos:
 *   node onboarding.js alta --cuit 20111111112 --razon "Mi Negocio" --iva monotributo --pv 1
 *   node onboarding.js certificado --cuit 20111111112 --key ./mi.key --crt ./mi.crt
 *   node onboarding.js productos --cuit 20111111112 --archivo productos.json
 *   node onboarding.js listar
 *   node onboarding.js ver --cuit 20111111112
 */

const fs = require("fs");
const path = require("path");

const NEGOCIOS_DIR = path.join(__dirname, "negocios");
const CONDICIONES_IVA_VALIDAS = ["responsable_inscripto", "monotributo", "exento", "consumidor_final"];

// ---------- utilidades ----------

function error(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`✓ ${msg}`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      args[key] = val;
    } else {
      args._.push(a);
    }
  }
  return args;
}

/**
 * Valida el CUIT con el algoritmo de dígito verificador de ARCA (módulo 11).
 * Devuelve true/false. No solo chequea el formato: confirma que el
 * dígito verificador sea matemáticamente correcto.
 */
function validarCuit(cuit) {
  if (!/^\d{11}$/.test(cuit)) return false;
  const digitos = cuit.split("").map(Number);
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((acc, peso, i) => acc + peso * digitos[i], 0);
  const resto = suma % 11;
  let verificador = 11 - resto;
  if (verificador === 11) verificador = 0;
  if (verificador === 10) return false; // CUIT matemáticamente inválido
  return verificador === digitos[10];
}

function negocioDir(cuit) {
  return path.join(NEGOCIOS_DIR, cuit);
}

function negocioExiste(cuit) {
  return fs.existsSync(negocioDir(cuit));
}

function cargarConfig(cuit) {
  const configPath = path.join(negocioDir(cuit), "config.json");
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

// ---------- comandos ----------

function comandoAlta(args) {
  const { cuit, razon, iva, pv } = args;

  if (!cuit || !razon || !iva || !pv) {
    error("Faltan datos. Uso: node onboarding.js alta --cuit <11 dígitos> --razon \"Nombre\" --iva <condición> --pv <punto de venta>");
  }
  if (!validarCuit(cuit)) {
    error(`El CUIT ${cuit} no es válido (falló el dígito verificador). Revisalo antes de continuar — un CUIT mal cargado factura mal después.`);
  }
  if (!CONDICIONES_IVA_VALIDAS.includes(iva)) {
    error(`Condición de IVA "${iva}" no reconocida. Usar una de: ${CONDICIONES_IVA_VALIDAS.join(", ")}`);
  }
  if (!/^\d+$/.test(pv)) {
    error("El punto de venta debe ser numérico (el que declaraste en ARCA).");
  }
  if (negocioExiste(cuit)) {
    error(`Ya existe un negocio dado de alta con CUIT ${cuit}. Usá "ver --cuit ${cuit}" para revisarlo.`);
  }

  const dir = negocioDir(cuit);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dir, "certs"), { recursive: true, mode: 0o700 });

  const config = {
    cuit,
    razonSocial: razon,
    condicionIva: iva,
    puntoVenta: Number(pv),
    ambiente: "homologacion", // homologacion | produccion — arranca siempre en homologación
    fechaAlta: new Date().toISOString(),
    certificadoCargado: false,
  };

  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "productos.json"), JSON.stringify([], null, 2), { mode: 0o600 });

  actualizarIndice(cuit, razon);

  ok(`Negocio "${razon}" (CUIT ${cuit}) dado de alta en negocios/${cuit}/`);
  console.log("  Ambiente inicial: homologación (sandbox de ARCA, sin costo ni límite)");
  console.log(`  Próximo paso: node onboarding.js certificado --cuit ${cuit} --key <ruta.key> --crt <ruta.crt>`);
}

function comandoCertificado(args) {
  const { cuit, key, crt } = args;
  if (!cuit || !key || !crt) {
    error("Uso: node onboarding.js certificado --cuit <cuit> --key <ruta al .key> --crt <ruta al .crt>");
  }
  if (!negocioExiste(cuit)) {
    error(`No existe un negocio con CUIT ${cuit}. Primero corré el comando "alta".`);
  }
  if (!fs.existsSync(key)) error(`No encuentro el archivo .key en "${key}"`);
  if (!fs.existsSync(crt)) error(`No encuentro el archivo .crt en "${crt}"`);

  const dir = negocioDir(cuit);
  const certsDir = path.join(dir, "certs");
  const destKey = path.join(certsDir, "certificado.key");
  const destCrt = path.join(certsDir, "certificado.crt");

  // Copiamos (nunca movemos el original) y forzamos permisos restrictivos:
  // solo el dueño del proceso puede leer el certificado.
  fs.copyFileSync(key, destKey);
  fs.copyFileSync(crt, destCrt);
  fs.chmodSync(destKey, 0o600);
  fs.chmodSync(destCrt, 0o600);

  const config = cargarConfig(cuit);
  config.certificadoCargado = true;
  config.certificadoFecha = new Date().toISOString();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 2), { mode: 0o600 });

  ok(`Certificado guardado y asegurado en negocios/${cuit}/certs/ (permisos 600, solo lectura del dueño)`);
  console.log("  Este negocio ya está listo para que el Motor Central pida su primer CAE en homologación.");
}

function comandoProductos(args) {
  const { cuit, archivo } = args;
  if (!cuit || !archivo) {
    error("Uso: node onboarding.js productos --cuit <cuit> --archivo <productos.json>");
  }
  if (!negocioExiste(cuit)) error(`No existe un negocio con CUIT ${cuit}.`);
  if (!fs.existsSync(archivo)) error(`No encuentro el archivo "${archivo}"`);

  let productos;
  try {
    productos = JSON.parse(fs.readFileSync(archivo, "utf8"));
  } catch (e) {
    error(`El archivo no es JSON válido: ${e.message}`);
  }
  if (!Array.isArray(productos)) error('El archivo debe ser un array: [{ "nombre": "...", "precio": 0, "alicuotaIva": 21 }]');

  for (const [i, p] of productos.entries()) {
    if (!p.nombre || typeof p.precio !== "number") {
      error(`Producto en posición ${i} inválido: necesita al menos "nombre" (string) y "precio" (number).`);
    }
    if (p.alicuotaIva === undefined) p.alicuotaIva = 21; // default más común
  }

  fs.writeFileSync(path.join(negocioDir(cuit), "productos.json"), JSON.stringify(productos, null, 2), { mode: 0o600 });
  ok(`Cargados ${productos.length} productos para el negocio ${cuit}.`);
}

function comandoListar() {
  const indicePath = path.join(NEGOCIOS_DIR, "index.json");
  if (!fs.existsSync(indicePath)) {
    console.log("Todavía no hay negocios dados de alta.");
    return;
  }
  const indice = JSON.parse(fs.readFileSync(indicePath, "utf8"));
  if (indice.length === 0) {
    console.log("Todavía no hay negocios dados de alta.");
    return;
  }
  console.log("Negocios registrados:\n");
  for (const n of indice) {
    const config = cargarConfig(n.cuit);
    const estado = config?.certificadoCargado ? "certificado ✓" : "falta certificado";
    console.log(`  ${n.cuit}  ${n.razonSocial}  [${config?.ambiente || "?"}]  (${estado})`);
  }
}

function comandoVer(args) {
  const { cuit } = args;
  if (!cuit) error("Uso: node onboarding.js ver --cuit <cuit>");
  if (!negocioExiste(cuit)) error(`No existe un negocio con CUIT ${cuit}.`);
  const config = cargarConfig(cuit);
  const productosPath = path.join(negocioDir(cuit), "productos.json");
  const productos = fs.existsSync(productosPath) ? JSON.parse(fs.readFileSync(productosPath, "utf8")) : [];
  console.log(JSON.stringify({ ...config, cantidadProductos: productos.length }, null, 2));
}

function actualizarIndice(cuit, razonSocial) {
  if (!fs.existsSync(NEGOCIOS_DIR)) fs.mkdirSync(NEGOCIOS_DIR, { recursive: true });
  const indicePath = path.join(NEGOCIOS_DIR, "index.json");
  const indice = fs.existsSync(indicePath) ? JSON.parse(fs.readFileSync(indicePath, "utf8")) : [];
  indice.push({ cuit, razonSocial, fechaAlta: new Date().toISOString() });
  fs.writeFileSync(indicePath, JSON.stringify(indice, null, 2));
}

// ---------- entrypoint ----------

function main() {
  const argv = process.argv.slice(2);
  const comando = argv[0];
  const args = parseArgs(argv.slice(1));

  const comandos = {
    alta: comandoAlta,
    certificado: comandoCertificado,
    productos: comandoProductos,
    listar: comandoListar,
    ver: comandoVer,
  };

  if (!comando || !comandos[comando]) {
    console.log("Comandos disponibles: alta, certificado, productos, listar, ver");
    console.log('Ejemplo: node onboarding.js alta --cuit 20111111112 --razon "Mi Negocio" --iva monotributo --pv 1');
    process.exit(comando ? 1 : 0);
  }

  comandos[comando](args);
}

main();
