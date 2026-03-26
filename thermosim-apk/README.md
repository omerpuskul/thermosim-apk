# ThermoSim v15 — Android APK

Termodinamik simülasyon toy model. Ters entropili madde, anti-Fourier, anti-difüzyon ve daha fazlası.

## GitHub Actions ile APK Derleme

1. Bu repoyu GitHub'a yükle
2. Actions sekmesine git
3. "Build APK" workflow'unu çalıştır (veya main branch'e push et)
4. Artifacts'tan `ThermoSim-v15.apk` indir

## Proje Yapısı

```
thermosim-apk/
├── .github/workflows/build.yml   ← GitHub Actions CI
├── web/
│   ├── ThermoSim.jsx             ← v15 React bileşeni
│   ├── index.jsx                 ← React giriş noktası
│   ├── build.js                  ← esbuild → tek HTML
│   └── package.json
├── app/src/main/
│   ├── assets/                   ← (build sırasında oluşur)
│   ├── java/.../MainActivity.java
│   ├── res/...
│   └── AndroidManifest.xml
├── build.gradle
├── settings.gradle
└── gradle/wrapper/...
```

## Derleme Adımları (otomatik)

1. Node.js ile `web/` klasöründe `npm install && npm run build`
   → React + JSX → tek `index.html` dosyası → `app/src/main/assets/`
2. Gradle 8.4 + AGP 8.1.4 ile Android APK derleme
3. APK artifact olarak yüklenir

## Yerel Derleme (opsiyonel)

```bash
# Web bundle
cd web && npm install && npm run build && cd ..

# APK (Gradle 8.4 gerekli)
gradle assembleRelease
```

## Gereksinimler

- JDK 17
- Node.js 20+
- Gradle 8.4 (AGP 8.1.4 ile uyumlu)
