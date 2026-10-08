# F5 BIG-IP TS Cookie POC

POC: obtener la cookie `TS*` (challenge del WAF F5 BIG-IP) desde **pjud.cl** corriendo Chrome headless en un contenedor, **sin display virtual (xvfb)** y con CDP puro.

## El problema

pjud.cl está detrás de un WAF F5 BIG-IP que no ejecuta su challenge JavaScript (el que genera la cookie `TS*`) cuando detecta `HeadlessChrome/xx.x` en el User-Agent.

## La solución

1. **`--headless=new`** — el modo headless moderno de Chrome (el browser completo sin ventanas). Permite correr en container sin display: renderiza en memoria.
2. **`Emulation.setUserAgentOverride`** con `userAgentMetadata` completa — antes de navegar, se sobreescribe el User-Agent (sin "Headless") y los datos de `navigator.userAgentData` (brands, platform, bitness) para que sean consistentes.
3. **Polling de cookies** — tras navegar, se consulta `Network.getCookies` hasta que aparece la cookie `TS*` (el challenge suele tardar 1-3s y recarga la página).

Verificado en host (Chrome + Node 24) y en container (`node:24-slim` + chromium): ambos obtienen la cookie `TS*` y el `csrfToken` de sesión.

## Requisitos

- Node >= 22 (usa `WebSocket` global, cero dependencias)
- Chrome o Chromium instalado

## Uso

```bash
# local
CHROME_BIN=/usr/bin/google-chrome node f5-ts-cookie-poc.mjs

# en container
docker build -t f5-ts-poc .
docker run --rm f5-ts-poc
```

## Salida esperada

```
[poc] lanzando /usr/bin/chromium headless=new...
[poc] navigator dice: Mozilla/5.0 (X11; Linux x86_64) ... Chrome/128.0.0.0 Safari/537.36 | headless=undefined
[poc] navegando a https://www.pjud.cl (el challenge F5 puede recargar la página)...

[poc] OK — cookie TS obtenida: TS01320ea5=01b485afe5...
[poc] cookies finales:
  TS6add129e027 = 08a336eaa2ab2...
  f5_cspm = 1234
  csrfToken = 26f1edf7301c...
  TS01320ea5 = 01b485afe5...
```

## Notas para producción

- Reutilizá el profile de Chrome (`--user-data-dir`) entre corridas para no pasar el challenge cada vez.
- El override de UA debe aplicarse después de `Target.createTarget` y antes de `Page.navigate`.
- En container: `--no-sandbox` (root) y `--disable-dev-shm-usage` (/dev/shm chico en Docker).
