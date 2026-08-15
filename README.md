# Alta y onboarding del negocio

Primer eslabón del circuito. Registra un negocio nuevo, valida su CUIT de verdad
(dígito verificador, no solo formato), guarda su certificado de ARCA de forma
segura y aislada, y carga sus productos iniciales.

## Requisitos

Solo Node.js (no necesita ninguna librería externa — corre con lo que trae Node).

## Comandos

**1. Dar de alta un negocio**
```
node onboarding.js alta --cuit 20111111112 --razon "Mi Negocio" --iva monotributo --pv 1
```
Condiciones de IVA válidas: `responsable_inscripto`, `monotributo`, `exento`, `consumidor_final`.
El negocio arranca siempre en ambiente `homologacion` (sandbox de ARCA).

**2. Cargar su certificado de ARCA**
```
node onboarding.js certificado --cuit 20111111112 --key ./mi.key --crt ./mi.crt
```
Copia los archivos a `negocios/<cuit>/certs/` y les pone permisos `600`
(solo el dueño del proceso puede leerlos). Los originales no se tocan.

**3. Cargar productos iniciales**

Armá un JSON así:
```json
[
  { "nombre": "Silla de madera", "precio": 45000, "alicuotaIva": 21 }
]
```
Y cargalo:
```
node onboarding.js productos --cuit 20111111112 --archivo productos.json
```

**4. Ver todos los negocios registrados**
```
node onboarding.js listar
```

**5. Ver el detalle de uno**
```
node onboarding.js ver --cuit 20111111112
```

## Cómo queda organizado (multi-tenant)

```
negocios/
  index.json                 <- lista liviana de todos los negocios (sin datos sensibles)
  <cuit>/
    config.json               <- razón social, IVA, punto de venta, ambiente
    productos.json             <- catálogo inicial
    certs/
      certificado.key          <- permisos 600
      certificado.crt          <- permisos 600
```

Cada negocio vive en su propia carpeta. Ningún negocio puede acceder a los
datos ni al certificado de otro — la base para cuando tengas más de un
piloto usando el mismo sistema.

## No incluido todavía (a propósito)

Este módulo NO se conecta a ARCA — solo prepara los datos para que el
Motor Central los use. El próximo eslabón es justamente ese: un script que
tome el certificado guardado acá, se autentique contra el web service de
ARCA (WSAA) en modo homologación, y pida el primer CAE de prueba.

Ese paso sí necesita conexión a internet real (para hablar con los
servidores de ARCA), así que conviene hacerlo en tu máquina o en Claude
Code Desktop en vez de este entorno de prueba.

## Próximo paso sugerido

1. Conseguí tu certificado de ARCA real (o el de tu primer negocio piloto)
   en modo homologación — es gratis, se saca desde tu clave fiscal.
2. Corré `alta`, `certificado` y `productos` con esos datos reales.
3. Seguimos con el script que conecta esto contra ARCA y pide el primer CAE.
