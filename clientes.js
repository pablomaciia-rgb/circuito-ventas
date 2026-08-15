#!/usr/bin/env node
/**
 * clientes.js — Padrón de clientes por negocio
 * ------------------------------------------------
 * Cuarto eslabón del circuito: resuelve la excepción "cliente ambiguo
 * o nuevo" del diagrama.
 *
 * Regla elegida (automático por defecto, sin trabar la venta):
 *   - Si el cliente YA existe en el padrón y tiene CUIT + condición de
 *     IVA cargados -> se usan esos datos para facturar correcto.
 *   - Si el cliente es NUEVO (no está en el padrón) -> se factura
 *     igual como Consumidor Final (no se pierde la venta), pero queda
 *     agregado al padrón como "pendiente" para completar después.
 *   - Si el cliente existe pero está "pendiente" (todavía sin CUIT
 *     cargado) -> se sigue facturando como Consumidor Final hasta que
 *     alguien lo complete.
 *
 * Los nombres se guardan tal cual pero se buscan sin distinguir
 * mayúsculas/acentos/espacios de más, para no duplicar "Juan Perez" y
 * "juan  perez" como si fueran dos personas distintas.
 *
 * Uso:
 *   node clientes.js listar --cuit 20448884148
 *   node clientes.js completar --cuit 20448884148 --nombre "Juan Perez" --clienteCuit 20111111112 --condicionIva monotributo
 *   node clientes.js ver --cuit 20448884148 --nombre "Juan Perez"
 *
 * También se usa como módulo desde el conector (no solo por consola):
 *   const { buscarOCrear } = require('./clientes');
 */

const fs = require("fs");
const path = require("path");

const NEGOCIOS_DIR = path.join(__dirname, "negocios");
const CONDICIONES_VALIDAS = ["responsable_inscripto", "monotributo", "exento", "consumidor_final"];

function error(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`✓ ${msg}`);
}

function normalizar(nombre) {
  return nombre
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // saca acentos
    .replace(/\s+/g, " ");
}

function rutaClientes(cuitNegocio) {
  return path.join(NEGOCIOS_DIR, cuitNegocio, "clientes.json");
}

function cargarClientes(cuitNegocio) {
  const p = rutaClientes(cuitNegocio);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function guardarClientes(cuitNegocio, clientes) {
  fs.writeFileSync(rutaClientes(cuitNegocio), JSON.stringify(clientes, null, 2), { mode: 0o600 });
}

/**
 * Busca un cliente por nombre. Si no existe, lo crea como "pendiente"
 * (sin CUIT ni condición de IVA todavía) y lo guarda.
 * Si se pasa un email y el cliente no tenía uno guardado, se lo suma
 * (así el conector puede ir completando el dato de a poco, sin pisar
 * un email que ya estaba cargado).
 * Devuelve { cliente, esNuevo }.
 */
function buscarOCrear(cuitNegocio, nombreCliente, email) {
  const clientes = cargarClientes(cuitNegocio);
  const clave = normalizar(nombreCliente);
  const existente = clientes.find((c) => normalizar(c.nombre) === clave);

  if (existente) {
    if (email && !existente.email) {
      existente.email = email;
      guardarClientes(cuitNegocio, clientes);
    }
    return { cliente: existente, esNuevo: false };
  }

  const nuevo = {
    nombre: nombreCliente,
    email: email || null,
    clienteCuit: null,
    condicionIva: null,
    estado: "pendiente", // pendiente | completo
    fechaAlta: new Date().toISOString(),
  };
  clientes.push(nuevo);
  guardarClientes(cuitNegocio, clientes);
  return { cliente: nuevo, esNuevo: true };
}

function comandoListar(args) {
  const { cuit } = args;
  if (!cuit) error("Uso: node clientes.js listar --cuit <cuit del negocio>");
  const clientes = cargarClientes(cuit);
  if (clientes.length === 0) {
    console.log("Todavía no hay clientes registrados para este negocio.");
    return;
  }
  console.log(`Clientes de ${cuit}:\n`);
  for (const c of clientes) {
    const estado = c.estado === "completo" ? `✓ ${c.condicionIva} (${c.clienteCuit})` : "⚠ pendiente de completar";
    console.log(`  ${c.nombre}  —  ${estado}`);
  }
  const pendientes = clientes.filter((c) => c.estado === "pendiente").length;
  if (pendientes > 0) {
    console.log(`\n${pendientes} cliente(s) pendiente(s) de completar datos.`);
  }
}

function comandoCompletar(args) {
  const { cuit, nombre, clienteCuit, condicionIva } = args;
  if (!cuit || !nombre || !clienteCuit || !condicionIva) {
    error('Uso: node clientes.js completar --cuit <negocio> --nombre "Nombre Cliente" --clienteCuit <cuit del cliente> --condicionIva <condición>');
  }
  if (!CONDICIONES_VALIDAS.includes(condicionIva)) {
    error(`Condición de IVA "${condicionIva}" no reconocida. Usar una de: ${CONDICIONES_VALIDAS.join(", ")}`);
  }
  if (!/^\d{11}$/.test(clienteCuit)) {
    error("El CUIT del cliente debe tener 11 dígitos.");
  }

  const clientes = cargarClientes(cuit);
  const clave = normalizar(nombre);
  const existente = clientes.find((c) => normalizar(c.nombre) === clave);

  if (!existente) {
    error(`No encuentro un cliente llamado "${nombre}" en el padrón de ${cuit}. Revisá el nombre exacto con "listar".`);
  }

  existente.clienteCuit = clienteCuit;
  existente.condicionIva = condicionIva;
  existente.estado = "completo";
  existente.fechaCompletado = new Date().toISOString();

  guardarClientes(cuit, clientes);
  ok(`Cliente "${nombre}" completado: CUIT ${clienteCuit}, ${condicionIva}. Las próximas facturas para este cliente van a usar estos datos.`);
}

function comandoVer(args) {
  const { cuit, nombre } = args;
  if (!cuit || !nombre) error('Uso: node clientes.js ver --cuit <negocio> --nombre "Nombre Cliente"');
  const clientes = cargarClientes(cuit);
  const clave = normalizar(nombre);
  const existente = clientes.find((c) => normalizar(c.nombre) === clave);
  if (!existente) {
    console.log(`No hay ningún cliente llamado "${nombre}" registrado todavía.`);
    return;
  }
  console.log(JSON.stringify(existente, null, 2));
}

// ---------- CLI ----------

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

if (require.main === module) {
  const argv = process.argv.slice(2);
  const comando = argv[0];
  const args = parseArgs(argv.slice(1));
  const comandos = { listar: comandoListar, completar: comandoCompletar, ver: comandoVer };

  if (!comando || !comandos[comando]) {
    console.log("Comandos disponibles: listar, completar, ver");
    process.exit(comando ? 1 : 0);
  }
  comandos[comando](args);
}

module.exports = { buscarOCrear, cargarClientes, normalizar };
