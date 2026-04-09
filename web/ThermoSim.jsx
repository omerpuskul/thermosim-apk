import { useState, useEffect, useRef, useCallback } from "react";

/* ═══════════════════════════════════════════════════════════════
   TERMODİNAMİK SİMÜLASYON — TOY MODEL (Mobil)
   ═══════════════════════════════════════════════════════════════ */

const SPEED_CAP = 400, ENERGY_CAP = 1e4;
const TYPE_A = 0, TYPE_B = 1, TYPE_AB = 2, TYPE_FUEL = 3, TYPE_OX = 4, TYPE_PRODUCT = 5;
const TYPE_H = 6, TYPE_HE = 7, TYPE_U = 8, TYPE_FR = 9, TYPE_N = 10;
const SECTOR_NORMAL = 0, SECTOR_REVERSE = 1;

const TEMP_COLORS = [
  [8,16,70],[20,60,180],[20,150,170],[60,200,60],[220,210,30],[230,120,15],[210,30,15]
];

function tempToColor(t, tMin=0, tMax=12) {
  const n = TEMP_COLORS.length - 1;
  const f = Math.max(0, Math.min(1, (t - tMin) / Math.max(tMax - tMin, .001)));
  const idx = f * n, lo = Math.floor(idx), hi = Math.min(lo+1, n), m = idx - lo;
  return `rgb(${Math.round(TEMP_COLORS[lo][0]*(1-m)+TEMP_COLORS[hi][0]*m)},${Math.round(TEMP_COLORS[lo][1]*(1-m)+TEMP_COLORS[hi][1]*m)},${Math.round(TEMP_COLORS[lo][2]*(1-m)+TEMP_COLORS[hi][2]*m)})`;
}
function tempToRGB(t, tMin=0, tMax=12) {
  const n = TEMP_COLORS.length - 1;
  const f = Math.max(0, Math.min(1, (t - tMin) / Math.max(tMax - tMin, .001)));
  const idx = f * n, lo = Math.floor(idx), hi = Math.min(lo+1, n), m = idx - lo;
  return [Math.round(TEMP_COLORS[lo][0]*(1-m)+TEMP_COLORS[hi][0]*m),Math.round(TEMP_COLORS[lo][1]*(1-m)+TEMP_COLORS[hi][1]*m),Math.round(TEMP_COLORS[lo][2]*(1-m)+TEMP_COLORS[hi][2]*m)];
}

function gaussRandom() {
  let u=0,v=0;
  while(u===0) u=Math.random();
  while(v===0) v=Math.random();
  return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
}
function randVel(temp) { const s=Math.sqrt(temp); return [gaussRandom()*s, gaussRandom()*s]; }
function createP(x,y,vx,vy,pt=TYPE_A,sec=SECTOR_NORMAL,mass=1,r=3.5) {
  // Nükleer parçacık kütle/yarıçap ayarları
  let m=mass, rd=r;
  if(pt===TYPE_H){m=0.5;rd=2.5;} else if(pt===TYPE_HE){m=2;rd=3;} 
  else if(pt===TYPE_U){m=4;rd=5;} else if(pt===TYPE_FR){m=2;rd=3.5;} 
  else if(pt===TYPE_N){m=0.3;rd=2;}
  return {x,y,vx,vy,ptype:pt,sector:sec,mass:m,radius:rd,energy:0,flash:0};
}

// ─── DUVAR ISI GEÇİRGENLİĞİ ───────────────────────────────────
/*
 * Duvar maddeyi engelleyebilir ama ısıyı geçirebilir (veya tersi).
 * Gerçek fizikte: cam pencere ışık geçirir ama hava geçirmez,
 * metal duvar ısıyı iletir ama maddeyi geçirmez, vb.
 *
 * wallThermalPerm = 0: tam yalıtkan (ısı geçmez)
 * wallThermalPerm = 1: tam iletken (duvarın iki yanı tamamen ısı paylaşır)
 *
 * Mekanizma: Duvarın her iki yanındaki parçacıkların ortalama
 * kinetik enerjisi hesaplanır. Fark varsa, wallThermalPerm oranında
 * sıcak taraftaki parçacıklar yavaşlatılır, soğuk taraftakiler
 * hızlandırılır. Böylece ısı duvardan "iletilir" ama madde geçmez.
 */
function wallThermalTransfer(ps, walls, dt, thermalPerm, timeRev) {
  if (!walls || walls.length === 0 || thermalPerm < 0.001) return;

  for (const w of walls) {
    if (Math.abs(w.x1 - w.x2) < 2) {
      const wx = (w.x1 + w.x2) / 2;
      const miny = Math.min(w.y1, w.y2), maxy = Math.max(w.y1, w.y2);
      const proximity = 60;

      const left = [], right = [];
      for (const p of ps) {
        if (p.y < miny - p.radius || p.y > maxy + p.radius) continue;
        const dist = Math.abs(p.x - wx);
        if (dist > proximity) continue;
        if (p.x < wx) left.push(p);
        else right.push(p);
      }

      if (left.length === 0 || right.length === 0) continue;

      let keL = 0, keR = 0;
      for (const p of left) keL += p.vx * p.vx + p.vy * p.vy;
      for (const p of right) keR += p.vx * p.vx + p.vy * p.vy;
      keL /= left.length;
      keR /= right.length;

      const diff = keL - keR;
      if (Math.abs(diff) < 0.01) continue;

      // timeRev: transfer yönünü ters çevir
      const transfer = diff * thermalPerm * dt * 2 * (timeRev ? -1 : 1);

      const scaleL = Math.sqrt(Math.max((keL - transfer / left.length) / Math.max(keL, 0.001), 0.1));
      const scaleR = Math.sqrt(Math.max((keR + transfer / right.length) / Math.max(keR, 0.001), 0.1));

      const clL = Math.max(0.9, Math.min(1.1, scaleL));
      const clR = Math.max(0.9, Math.min(1.1, scaleR));

      for (const p of left) { p.vx *= clL; p.vy *= clL; }
      for (const p of right) { p.vx *= clR; p.vy *= clR; }
    }
  }
}

// ─── DUVAR ZORLAMA YARDIMCISI ──────────────────────────────────
/*
 * Parçacığın duvarın yanlış tarafında olup olmadığını kontrol eder.
 * Çarpışma çözümü, antiDiffusion, v→-v gibi işlemler parçacıkları
 * duvarın öbür tarafına itebilir. Bu fonksiyon her zaman doğru
 * tarafta tutmayı garanti eder.
 */
function enforceWalls(ps, walls, wallSolidity, d) {
  if (!walls || walls.length === 0) return;
  const sol = (typeof wallSolidity === "number") ? wallSolidity : 1;
  if (sol < 0.001) return; // Tam saydam, kontrol gereksiz

  for (const w of walls) {
    if (Math.abs(w.x1 - w.x2) < 2) {
      const wx = (w.x1 + w.x2) / 2;
      const miny = Math.min(w.y1, w.y2), maxy = Math.max(w.y1, w.y2);
      for (const p of ps) {
        if (p.y < miny - p.radius || p.y > maxy + p.radius) continue;
        // _wallSide: parçacığın başlangıçtaki tarafı (true = sol)
        // İlk defa geçiyorsa _wallSide atanmamıştır
        if (typeof p._wallSide === "undefined") {
          p._wallSide = p.x < wx;
        }
        const currentSide = p.x < wx;
        if (currentSide !== p._wallSide) {
          // Taraf değişmiş → geçirgenlik kontrolü
          if (Math.random() < sol) {
            // Engelle: eski tarafa geri it
            if (p._wallSide) {
              p.x = wx - p.radius - 1;
              if (p.vx > 0) p.vx *= -d;
            } else {
              p.x = wx + p.radius + 1;
              if (p.vx < 0) p.vx *= -d;
            }
          } else {
            // Geçiş izni verildi → yeni tarafı kaydet
            p._wallSide = currentSide;
          }
        }
      }
    }
  }
}

// ─── PHYSICS ───────────────────────────────────────────────────
function physicsStep(ps, W, H, dt, mode, rest, coupling, walls, thermRev, thermRevRate, wallSolidity, thermClamp, timeReversed) {
  const isRev = mode==="reverse"||mode==="mixed_physical"||mode==="mixed_cinematic";
  if(isRev) for(const p of ps) if(p.sector===SECTOR_REVERSE){p.vx*=-1;p.vy*=-1;}

  for(const p of ps){p.x+=p.vx*dt;p.y+=p.vy*dt;}
  // Zaman tersinde: sönüm → enerji kazanımı (d>1), elastiklik → ters (e→1/e capped)
  const tRev = !!timeReversed;
  const d = tRev ? 1.02 : 0.98;
  const effRest = tRev ? Math.min(1 / Math.max(rest, 0.1), 1.5) : rest;
  for(const p of ps){
    if(p.x<p.radius){p.x=p.radius;p.vx=Math.abs(p.vx)*d;}
    if(p.x>W-p.radius){p.x=W-p.radius;p.vx=-Math.abs(p.vx)*d;}
    if(p.y<p.radius){p.y=p.radius;p.vy=Math.abs(p.vy)*d;}
    if(p.y>H-p.radius){p.y=H-p.radius;p.vy=-Math.abs(p.vy)*d;}
  }
  // Duvar kontrolü #1: pozisyon güncellemesi sonrası
  enforceWalls(ps, walls, wallSolidity, d);
  const cs=16,grid={};
  for(let i=0;i<ps.length;i++){
    const k=`${Math.floor(ps[i].x/cs)},${Math.floor(ps[i].y/cs)}`;
    (grid[k]||(grid[k]=[])).push(i);
  }
  // Duvar ayırım kontrolü için yardımcı: iki parçacık arası duvar var mı?
  const wallSep = (walls && walls.length > 0 && wallSolidity > 0.001);

  for(const key in grid){
    const[cx,cy]=key.split(",").map(Number);
    for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++){
      const nk=`${cx+dx},${cy+dy}`;
      if(!grid[nk]) continue;
      for(const i of grid[key]) for(const j of grid[nk]){
        if(i>=j) continue;
        const a=ps[i],b=ps[j],ddx=b.x-a.x,ddy=b.y-a.y,ds=ddx*ddx+ddy*ddy,md=a.radius+b.radius;
        if(ds>=md*md||ds<.001) continue;

        // DUVAR AYIRIM KONTROLÜ: aralarında duvar varsa çarpışma yok
        if(wallSep){
          let blocked=false;
          for(const w of walls){
            if(Math.abs(w.x1-w.x2)<2){
              const wx=(w.x1+w.x2)/2;
              const miny=Math.min(w.y1,w.y2), maxy=Math.max(w.y1,w.y2);
              // Her iki parçacık da duvarın y aralığında mı?
              const midY=(a.y+b.y)/2;
              if(midY > miny && midY < maxy){
                // Farklı taraftalar mı?
                if((a.x<wx && b.x>=wx)||(a.x>=wx && b.x<wx)){
                  blocked=true; break;
                }
              }
            }
          }
          if(blocked) continue; // Bu çifti atla
        }

        const dist=Math.sqrt(ds),nx=ddx/dist,ny=ddy/dist,ol=md-dist,tm=a.mass+b.mass;
        a.x-=nx*(ol*b.mass/tm)*.5;a.y-=ny*(ol*b.mass/tm)*.5;
        b.x+=nx*(ol*a.mass/tm)*.5;b.y+=ny*(ol*a.mass/tm)*.5;
        const dvx=a.vx-b.vx,dvy=a.vy-b.vy,dvn=dvx*nx+dvy*ny;
        if(dvn<0) continue;
        const e=effRest;
        let tf=1;
        if(a.sector!==b.sector&&(mode==="mixed_physical"||mode==="mixed_cinematic"))
          tf=mode==="mixed_physical"?coupling:1;
        const imp=(1+e)*dvn/(1/a.mass+1/b.mass);
        a.vx-=(imp*nx)/a.mass;a.vy-=(imp*ny)/a.mass;
        b.vx+=(imp*nx)/b.mass;b.vy+=(imp*ny)/b.mass;
        if(e<1){const loss=.5*imp*dvn*(1-e*e)*tf;a.energy+=loss*b.mass/tm;b.energy+=loss*a.mass/tm;}
        if(thermRev && thermRevRate > 0.001 && a.sector===SECTOR_REVERSE && b.sector===SECTOR_REVERSE){
          antiCollisionFourier(a, b, thermRevRate, thermClamp, timeReversed);
        }
      }
    }
  }
  // Duvar kontrolü #2: çarpışma çözümü sonrası (overlap itme duvarı geçirebilir)
  enforceWalls(ps, walls, wallSolidity, d);
  if(isRev) for(const p of ps) if(p.sector===SECTOR_REVERSE){p.vx*=-1;p.vy*=-1;}
  if((mode==="mixed_physical"||mode==="mixed_cinematic")&&coupling>.001){
    const kappa=mode==="mixed_physical"?coupling:Math.min(coupling*3,1);
    let sN=0,cN=0,sR=0,cR=0;
    for(const p of ps){const ke=.5*p.mass*(p.vx*p.vx+p.vy*p.vy);if(p.sector===SECTOR_NORMAL){sN+=ke;cN++;}else{sR+=ke;cR++;}}
    if(cN>0&&cR>0){
      const aN=sN/cN,aR=sR/cR,tr=kappa*(aN-aR)*dt*.1;
      if(Math.abs(tr)>1e-10){
        const scN=Math.sqrt(Math.max(1-tr/Math.max(aN,1e-6),.1)),scR=Math.sqrt(Math.max(1+tr/Math.max(aR,1e-6),.1));
        for(const p of ps){if(p.sector===SECTOR_NORMAL){p.vx*=scN;p.vy*=scN;}else{p.vx*=scR;p.vy*=scR;}}
      }
    }
  }
  const spdCap = tRev ? SPEED_CAP * 2 : SPEED_CAP;
  for(const p of ps){
    const spd=Math.sqrt(p.vx*p.vx+p.vy*p.vy);
    if(spd>spdCap){const sc=spdCap/spd;p.vx*=sc;p.vy*=sc;}
    if(isNaN(p.x)||isNaN(p.y)||isNaN(p.vx)||isNaN(p.vy)||!isFinite(p.vx)||!isFinite(p.vy)){p.x=W/2;p.y=H/2;p.vx=0;p.vy=0;}
    if(p.energy>ENERGY_CAP) p.energy=ENERGY_CAP;
    p.flash=Math.max(0,p.flash-dt);
  }
  // Duvar kontrolü #3: son güvenlik geçişi (v→-v sonrası hiçbir şey kaçmasın)
  enforceWalls(ps, walls, wallSolidity, d);
}

// ─── SPATIAL GRID (Integer key — string overhead yok) ──────────
const GRID_COLS = 1000; // max grid genişliği
function buildGrid(ps, cs, filter) {
  const g = new Map();
  for (let i = 0; i < ps.length; i++) {
    if (filter && !filter(ps[i])) continue;
    const k = (Math.floor(ps[i].x / cs)) * GRID_COLS + Math.floor(ps[i].y / cs);
    const c = g.get(k);
    if (c) c.push(i); else g.set(k, [i]);
  }
  return g;
}
function gridNearbyPairs(g, cs, radius, ps, cb) {
  const rSq = radius * radius;
  const span = Math.ceil(radius / cs);
  for (const [key, cell] of g) {
    const cx = (key / GRID_COLS) | 0, cy = key % GRID_COLS;
    // Aynı hücre
    for (let a = 0; a < cell.length; a++)
      for (let b = a + 1; b < cell.length; b++)
        cb(cell[a], cell[b], rSq);
    // İleri komşular (çift sayım önle)
    for (let dx = 0; dx <= span; dx++) {
      for (let dy = (dx === 0 ? 1 : -span); dy <= span; dy++) {
        const nk = (cx + dx) * GRID_COLS + (cy + dy);
        const nc = g.get(nk);
        if (!nc) continue;
        for (let a = 0; a < cell.length; a++)
          for (let b = 0; b < nc.length; b++)
            cb(cell[a], nc[b], rSq);
      }
    }
  }
}

// ─── ANTİ-FOURİER TERMAL REVERSE ──────────────────────────────
/*
 * Çarpışma bazlı + post-step cascade.
 * Sıcak reverse cisim soğuktan enerji ÇALAR → ısı tek cisme toplanır.
 * rate=1 → tam cascade.
 */
function antiCollisionFourier(a, b, rate, clamp, timeRev) {
  if (rate < 0.001) return;
  if (a.sector !== SECTOR_REVERSE || b.sector !== SECTOR_REVERSE) return;
  const keA = a.vx * a.vx + a.vy * a.vy;
  const keB = b.vx * b.vx + b.vy * b.vy;
  const diff = timeRev ? -(keA - keB) : (keA - keB);
  if (Math.abs(diff) < 0.001) return;
  let transfer = diff * rate * 0.5;
  const cl = typeof clamp === "number" ? clamp : 0.5;
  if (cl < 0.001) return;
  if (cl <= 1.0) {
    if (transfer > 0) { transfer = Math.min(transfer, keB * cl); }
    else { transfer = Math.max(transfer, -keA * cl); }
  }
  if (Math.abs(transfer) < 0.0001) return;
  const newKeA = keA + transfer, newKeB = keB - transfer;
  const factorA = newKeA > 0 ? Math.sqrt(newKeA / Math.max(keA, 0.001)) : 0.01;
  const factorB = newKeB > 0 ? Math.sqrt(newKeB / Math.max(keB, 0.001)) : 0.01;
  a.vx *= Math.min(factorA, 5.0); a.vy *= Math.min(factorA, 5.0);
  b.vx *= factorB; b.vy *= factorB;
}

function antiFourierStep(ps, W, H, dt, rate, clamp, timeRev) {
  if (rate < 0.001) return;
  const cl = typeof clamp === "number" ? clamp : 0.5;
  if (cl < 0.001) return;
  const radius = 40, radiusSq = radius * radius;

  // Çift etkileşim fonksiyonu
  function interact(i, j, rSq) {
    const a = ps[i], b = ps[j];
    const dx = b.x - a.x, dy = b.y - a.y;
    if (dx * dx + dy * dy > rSq) return;
    const keA = a.vx * a.vx + a.vy * a.vy;
    const keB = b.vx * b.vx + b.vy * b.vy;
    const diff = timeRev ? -(keA - keB) : (keA - keB);
    if (Math.abs(diff) < 0.001) return;
    let transfer = diff * rate * dt;
    if (cl <= 1.0) {
      if (transfer > 0) { transfer = Math.min(transfer, keB * cl); }
      else { transfer = Math.max(transfer, -keA * cl); }
    }
    if (Math.abs(transfer) < 0.0001) return;
    const newKeA = keA + transfer, newKeB = keB - transfer;
    const factorA = newKeA > 0 ? Math.sqrt(newKeA / Math.max(keA, 0.0001)) : 0.01;
    const factorB = newKeB > 0 ? Math.sqrt(newKeB / Math.max(keB, 0.0001)) : 0.01;
    a.vx *= Math.min(factorA, 3.0); a.vy *= Math.min(factorA, 3.0);
    b.vx *= factorB; b.vy *= factorB;
  }

  // N≥80: grid, altında: brute-force
  const revFilter = p => p.sector === SECTOR_REVERSE;
  let revCount = 0;
  for (let i = 0; i < ps.length; i++) if (revFilter(ps[i])) revCount++;
  if (revCount < 2) return;

  if (revCount >= 80) {
    const g = buildGrid(ps, radius, revFilter);
    gridNearbyPairs(g, radius, radius, ps, interact);
  } else {
    const rev = [];
    for (let i = 0; i < ps.length; i++) if (revFilter(ps[i])) rev.push(i);
    for (let ii = 0; ii < rev.length; ii++)
      for (let jj = ii + 1; jj < rev.length; jj++)
        interact(rev[ii], rev[jj], radiusSq);
  }
}

// ─── ANTİ-DİFÜZYON (UZAMSAL TERS ENTROPİ — İKİ MOD) ──────────
/*
 * İki mod:
 *
 * TOPLANMA (cluster): Reverse parçacıklar COM'a doğru çekilir.
 *   Dağınık → kümelenmiş. Entropi azalır. Kümelenirken ısınır.
 *   Normal fiziğin tersi: gaz yayılmak yerine toplanır.
 *
 * DAĞILMA (disperse): Reverse parçacıklar COM'dan uzaklaştırılır.
 *   Kümelenmiş → dağınık. Pozisyon bazlı itme (v→-v'den etkilenmez).
 *   Normal difüzyonu hızlandırılmış şekilde uygular.
 *
 * Her iki mod da pozisyon bazlıdır (v→-v trick'inden bağımsız).
 */
function antiDiffusionStep(ps, W, H, dt, rate, mode, walls, wallSolidity, heatMode, timeRev) {
  if (rate < 0.001) return;

  let sign = mode === "disperse" ? -1 : 1;
  // Zaman tersinde: toplanma↔dağılma
  if (timeRev) sign *= -1;
  const sol = (typeof wallSolidity === "number") ? wallSolidity : 1;
  // heatMode: "heat" (ısınır), "none" (termal etki yok), "cool" (soğur)
  // timeRev: termal etkiyi de ters çevir
  let thermal = heatMode || "none";
  if (timeRev && thermal === "heat") thermal = "cool";
  else if (timeRev && thermal === "cool") thermal = "heat";

  let comX = 0, comY = 0, totalM = 0, count = 0;
  for (const p of ps) {
    if (p.sector !== SECTOR_REVERSE) continue;
    comX += p.x * p.mass;
    comY += p.y * p.mass;
    totalM += p.mass;
    count++;
  }
  if (count < 2) return;
  comX /= totalM;
  comY /= totalM;

  const maxDist = Math.sqrt(W * W + H * H) * 0.5;

  for (const p of ps) {
    if (p.sector !== SECTOR_REVERSE) continue;

    const dx = comX - p.x;
    const dy = comY - p.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 3) continue;

    const normDist = dist / maxDist;
    const strength = rate * normDist;

    const nudge = strength * dt * 2.5;
    const nx = (dx / dist) * nudge * dist * 0.15 * sign;
    const ny = (dy / dist) * nudge * dist * 0.15 * sign;

    const oldX = p.x;
    p.x += nx;
    p.y += ny;

    p.x = Math.max(p.radius + 1, Math.min(W - p.radius - 1, p.x));
    p.y = Math.max(p.radius + 1, Math.min(H - p.radius - 1, p.y));

    if (walls && walls.length > 0) {
      for (const w of walls) {
        if (Math.abs(w.x1 - w.x2) < 2) {
          const wx = (w.x1 + w.x2) / 2;
          const miny = Math.min(w.y1, w.y2), maxy = Math.max(w.y1, w.y2);
          if (p.y > miny - p.radius && p.y < maxy + p.radius) {
            const wasBefore = oldX < wx;
            const isNowAfter = p.x >= wx;
            const wasAfter = oldX >= wx;
            const isNowBefore = p.x < wx;
            if ((wasBefore && isNowAfter) || (wasAfter && isNowBefore)) {
              if (Math.random() < sol) {
                if (wasBefore) { p.x = wx - p.radius - 2; }
                else { p.x = wx + p.radius + 2; }
              }
            }
          }
        }
      }
    }

    // TERMAL ETKİ — doğrudan heatMode ile kontrol
    if (thermal === "heat") {
      const speedBoost = 1 + strength * dt * 0.3;
      p.vx *= speedBoost;
      p.vy *= speedBoost;
    } else if (thermal === "cool") {
      const speedDamp = 1 - strength * dt * 0.2;
      const clamp = Math.max(speedDamp, 0.9);
      p.vx *= clamp;
      p.vy *= clamp;
    }
    // "none" → hiçbir şey yapma
  }
}

// ─── REACTIONS ─────────────────────────────────────────────────
const CHEM_RXNS=[
  {name:"A+B→AB",r:[TYPE_A,TYPE_B],p:[TYPE_AB],ea:3,dh:-2,kf:.8,kb:.3,bin:true,chem:true},
  {name:"Fuel+Ox→Ür",r:[TYPE_FUEL,TYPE_OX],p:[TYPE_PRODUCT],ea:4,dh:-5,kf:1,kb:.05,bin:true,chem:true},
  {name:"AB→A+B",r:[TYPE_AB],p:[TYPE_A,TYPE_B],ea:5,dh:2,kf:.4,kb:.6,bin:false,chem:true},
];
const NUC_RXNS=[
  {name:"H+H→He",r:[TYPE_H,TYPE_H],p:[TYPE_HE],ea:8,dh:-8,kf:.6,kb:.1,bin:true},
  {name:"U+n→2Fr+2n",r:[TYPE_U,TYPE_N],p:[TYPE_FR,TYPE_FR,TYPE_N,TYPE_N],ea:1,dh:-10,kf:1,kb:.01,bin:true},
  {name:"U→2Fr+n",r:[TYPE_U],p:[TYPE_FR,TYPE_FR,TYPE_N],ea:12,dh:-6,kf:.02,kb:.001,bin:false},
];
function rxnStep(ps,dt,mode,rr,chemOn,nucOn,eam,isr,timeRev,dhShift,balMul){
  if(!chemOn && !nucOn) return 0;
  const RXNS = [];
  if(chemOn) RXNS.push(...CHEM_RXNS);
  if(nucOn) RXNS.push(...NUC_RXNS);
  let rxnCount = 0;
  const dhs = typeof dhShift === "number" ? dhShift : 0;
  const bal = typeof balMul === "number" && balMul > 0 ? balMul : 1;

  // Kimyasal takma ad: nükleer parçacıklar kimyasal reaksiyonlarda rol üstlenir
  // H,U,N → A rolü | Fr → B rolü | He,Product → AB rolü
  const chemAlias = chemOn ? {
    [TYPE_H]: TYPE_A, [TYPE_U]: TYPE_A, [TYPE_N]: TYPE_A,
    [TYPE_FR]: TYPE_B, [TYPE_HE]: TYPE_AB, [TYPE_PRODUCT]: TYPE_AB,
  } : {};
  function matchType(ptype) { return chemAlias[ptype] !== undefined ? chemAlias[ptype] : ptype; }

  // ── İKİ PARÇACIKLI REAKSİYONLAR ──
  const toReactBin = [];
  const usedIdx = new Set();
  const rrSq = rr * rr;

  function checkPair(i, j, rSq) {
    if(usedIdx.has(i) || usedIdx.has(j)) return;
    const a=ps[i],b=ps[j],dx=b.x-a.x,dy=b.y-a.y;
    if(dx*dx+dy*dy>rSq) return;
    if(a.sector!==b.sector&&!isr) return;
    for(const rule of RXNS){
      if(!rule.bin) continue;
      // Kimyasal kurallar için alias kullan, nükleer kurallar için gerçek tip
      const ta = rule.chem ? matchType(a.ptype) : a.ptype;
      const tb = rule.chem ? matchType(b.ptype) : b.ptype;
      if(!((ta===rule.r[0]&&tb===rule.r[1])||(ta===rule.r[1]&&tb===rule.r[0]))) continue;
      const temp=Math.max(0.5*((a.vx*a.vx+a.vy*a.vy)+(b.vx*b.vx+b.vy*b.vy))*0.5, 0.01);
      const isR=a.sector===SECTOR_REVERSE&&(mode==="reverse"||mode.startsWith("mixed"));
      let ekf = rule.kf * bal, ekb = rule.kb / bal;
      if(isR) { const tmp=ekf; ekf=ekb; ekb=tmp; }
      if(timeRev) { const tmp=ekf; ekf=ekb; ekb=tmp; }
      const rawRate = ekf > 0.001 ? ekf * Math.exp(-rule.ea*eam/temp) : 0;
      const prob = 1 - Math.exp(-rawRate * dt);
      if(Math.random() > prob) return;
      toReactBin.push({i, j, rule, sec:a.sector});
      usedIdx.add(i); usedIdx.add(j);
      return;
    }
  }

  if (ps.length >= 80) {
    const g = buildGrid(ps, Math.max(rr, 4), null);
    gridNearbyPairs(g, Math.max(rr, 4), rr, ps, checkPair);
  } else {
    for(let i=0;i<ps.length;i++){
      if(usedIdx.has(i)) continue;
      for(let j=i+1;j<ps.length;j++){
        if(usedIdx.has(j)) continue;
        checkPair(i, j, rrSq);
      }
    }
  }

  const toRemove = new Set();
  const toAdd = [];
  for(const rx of toReactBin){
    toRemove.add(rx.i); toRemove.add(rx.j);
    const a=ps[rx.i], b=ps[rx.j];
    const mx=(a.x+b.x)/2, my=(a.y+b.y)/2, mvx=(a.vx+b.vx)/2, mvy=(a.vy+b.vy)/2;
    const totalKE = 0.5*a.mass*(a.vx*a.vx+a.vy*a.vy) + 0.5*b.mass*(b.vx*b.vx+b.vy*b.vy);
    const effDh = rx.rule.dh + dhs; // Efektif entalpi farkı
    for(const pt of rx.rule.p){
      let nvx=mvx+gaussRandom()*0.5, nvy=mvy+gaussRandom()*0.5;
      if(effDh<0){
        const targetKE = totalKE + Math.abs(effDh);
        const curKE = 0.5*(nvx*nvx+nvy*nvy) * rx.rule.p.length;
        if(curKE > 0.01){
          const scale = Math.sqrt(targetKE / (curKE * rx.rule.p.length));
          nvx *= Math.min(scale, 3); nvy *= Math.min(scale, 3);
        }
      }
      const np=createP(mx+(Math.random()-0.5)*6, my+(Math.random()-0.5)*6, nvx, nvy, pt, rx.sec);
      np.flash=0.3;
      toAdd.push(np);
    }
    rxnCount++;
  }

  const removeArr = [...toRemove].sort((a,b)=>b-a);
  for(const idx of removeArr) ps.splice(idx, 1);
  for(const np of toAdd) ps.push(np);

  // ── TEK PARÇACIKLI REAKSİYONLAR ──
  const toReactUni = [];
  const usedUni = new Set();

  for(let i=0;i<ps.length;i++){
    if(usedUni.has(i)) continue;
    const a=ps[i];
    for(const rule of RXNS){
      if(rule.bin) continue;
      const ta = rule.chem ? matchType(a.ptype) : a.ptype;
      if(ta!==rule.r[0]) continue;
      const temp=Math.max(0.5*(a.vx*a.vx+a.vy*a.vy), 0.01);
      const isR=a.sector===SECTOR_REVERSE&&(mode==="reverse"||mode.startsWith("mixed"));
      let ekf = rule.kf * bal, ekb = rule.kb / bal;
      if(isR) { const tmp=ekf; ekf=ekb; ekb=tmp; }
      if(timeRev) { const tmp=ekf; ekf=ekb; ekb=tmp; }
      const rawRate = ekf > 0.001 ? ekf * Math.exp(-rule.ea*eam/temp) : 0;
      const prob = 1 - Math.exp(-rawRate * dt);
      if(Math.random() > prob) continue;
      const ke=0.5*a.mass*(a.vx*a.vx+a.vy*a.vy);
      const effDh = rule.dh + dhs;
      if(effDh>0 && ke<effDh) continue; // Endotermik: yeterli enerji lazım
      toReactUni.push({i, rule, sec:a.sector});
      usedUni.add(i);
      break;
    }
  }

  const toRemoveUni = [...usedUni].sort((a,b)=>b-a);
  const toAddUni = [];
  for(const rx of toReactUni){
    const a=ps[rx.i];
    const sx=a.x, sy=a.y;
    let svx=a.vx, svy=a.vy;
    const ke=0.5*a.mass*(a.vx*a.vx+a.vy*a.vy);
    const effDh = rx.rule.dh + dhs;
    if(effDh>0){
      const sl=Math.sqrt(Math.max((ke-effDh)/Math.max(ke,0.001), 0.01));
      svx*=sl; svy*=sl;
    }
    for(let k=0;k<rx.rule.p.length;k++){
      const ang=(2*Math.PI*k)/rx.rule.p.length+gaussRandom()*0.3;
      const np=createP(sx+Math.cos(ang)*5, sy+Math.sin(ang)*5,
        svx*0.7+gaussRandom()*1.5, svy*0.7+gaussRandom()*1.5,
        rx.rule.p[k], rx.sec);
      np.flash=0.3;
      toAddUni.push(np);
    }
    rxnCount++;
  }

  for(const idx of toRemoveUni) ps.splice(idx, 1);
  for(const np of toAddUni) ps.push(np);

  return rxnCount;
}

// ─── ENTROPY ───────────────────────────────────────────────────
function calcEntropy(ps,W,H,gr=8,vb=10,ab=8){
  const n=ps.length;if(n<2) return 0;
  const cc=new Array(gr*gr).fill(0);
  for(const p of ps){cc[Math.min(Math.max(Math.floor(p.x/W*gr),0),gr-1)*gr+Math.min(Math.max(Math.floor(p.y/H*gr),0),gr-1)]++;}
  let sP=0;for(const c of cc){if(c>0){const pr=c/n;sP-=pr*Math.log(pr);}}
  let mx=.001;for(const p of ps){const sp=Math.sqrt(p.vx*p.vx+p.vy*p.vy);if(sp>mx)mx=sp;}
  const sh=new Array(vb).fill(0),ah=new Array(ab).fill(0);
  for(const p of ps){
    sh[Math.min(Math.floor(Math.sqrt(p.vx*p.vx+p.vy*p.vy)/mx*vb),vb-1)]++;
    ah[Math.min(Math.floor((Math.atan2(p.vy,p.vx)+Math.PI)/(2*Math.PI)*ab),ab-1)]++;
  }
  let sV=0;
  for(const c of sh){if(c>0){const pr=c/n;sV-=pr*Math.log(pr);}}
  for(const c of ah){if(c>0){const pr=c/n;sV-=pr*Math.log(pr);}}
  return sP+sV;
}
function decoherence(ps,W,H){
  const rev=ps.filter(p=>p.sector===SECTOR_REVERSE);
  if(rev.length<2) return 0;
  return Math.min(calcEntropy(rev,W,H)/(Math.log(64)+Math.log(10)+Math.log(8)),1);
}

// ─── PRESETS ───────────────────────────────────────────────────
// Her preset TÜM ilgili state alanlarını döner.
// Her preset HER ZAMAN nNorm kadar normal + nRev kadar ters parçacık üretir.
// Preset sadece UZAMSAL DAĞILIM KALIBINI belirler.
const PRESET_DEFAULTS = {
  mode:"normal", rxn:false, nucRxn:false, coup:0, walls:[], rxnDh:0, rxnBal:1, rxnRad:12, rxnABRatio:0.5, rxnProductRatio:0, nucDh:0, nucBal:1, nucRad:12, nucHURatio:0.5, nucNPct:0.1, hotColdRatio:0.5,
  thermRev:false, thermRevRate:0.5, thermClamp:0.5,
  spatialRev:false, spatialRevRate:0.2, spatialRevMode:"cluster", spatialHeatMode:"heat",
  revMode:"dynamic", wallSolidity:1.0, wallThermalPerm:0.0, wallLeftTemp:0.5, wallRightTemp:0.5, wallLeftNormPct:0.5, wallLeftRevPct:0.5,
  pCntNorm:80, pCntRev:0,
};

function makePreset(name, W, H, nNorm, nRev){
  const ps=[];
  let cfg = {...PRESET_DEFAULTS};
  const _nN = nNorm, _nR = nRev; // null olabilir → preset default kullanılır

  // nn/nr'yi cfg ayarlandıktan sonra çöz
  function res() { return [_nN != null ? _nN : cfg.pCntNorm, _nR != null ? _nR : cfg.pCntRev]; }

  function addParticles(count, sector, patternFn) {
    for (let i = 0; i < count; i++) {
      const p = patternFn(i, count);
      ps.push(createP(p.x, p.y, p.vx, p.vy, p.ptype || TYPE_A, sector));
    }
  }

  switch(name){
    case "default_mode": {
      cfg.pCntNorm=100; cfg.pCntRev=0;
      // Rastgele dağılımlı, orta hızlı normal parçacıklar
      const [nn,nr]=res();
      addParticles(nn, SECTOR_NORMAL, () => {
        const [vx,vy] = randVel(4);
        return { x: Math.random()*(W-20)+10, y: Math.random()*(H-20)+10, vx, vy };
      });
      addParticles(nr, SECTOR_REVERSE, () => {
        const [vx,vy] = randVel(4);
        return { x: Math.random()*(W-20)+10, y: Math.random()*(H-20)+10, vx, vy };
      });
      cfg.mode = nr>0 && nn===0 ? "reverse" : nr>0 ? "mixed_physical" : "normal";
      cfg.coup = nr>0 && nn>0 ? 0.1 : 0;
      break;
    }
    case "hot_cold": {
      cfg.pCntNorm=100; cfg.pCntRev=0;
      // Dağılım: sol yarı sıcak, sağ yarı soğuk
      const hotColdPattern = (i, count) => {
        const hot = i < count / 2;
        const [vx,vy] = randVel(hot ? 8 : 1);
        return { x: hot ? Math.random()*(W/2-20)+10 : W/2+10+Math.random()*(W/2-20), y: Math.random()*(H-20)+10, vx, vy };
      };
      const [nn,nr]=res();
      addParticles(nn, SECTOR_NORMAL, hotColdPattern);
      addParticles(nr, SECTOR_REVERSE, hotColdPattern);
      cfg.mode = nr>0 && nn===0 ? "reverse" : nr>0 ? "mixed_physical" : "normal";
      cfg.coup = nr>0 && nn>0 ? 0.1 : 0;
      break;
    }
    case "reverse": {
      cfg.pCntNorm=0; cfg.pCntRev=100;
      cfg.spatialRev=true; cfg.spatialRevMode="cluster"; cfg.spatialHeatMode="heat";
      // Dağılım: rastgele, orta hız
      const scatterPattern = (i, count) => {
        const [vx,vy] = randVel(3);
        return { x: Math.random()*(W-20)+10, y: Math.random()*(H-20)+10, vx, vy };
      };
      const [nn,nr]=res();
      addParticles(nn, SECTOR_NORMAL, scatterPattern);
      addParticles(nr, SECTOR_REVERSE, scatterPattern);
      cfg.mode = nn>0 ? "mixed_physical" : "reverse";
      cfg.coup = nn>0 ? 0.1 : 0;
      cfg.revMode = "dynamic";
      break;
    }
    case "rxn_ab": {
      cfg.pCntNorm=100; cfg.pCntRev=0; cfg.rxn=true;
      // Dağılım: rastgele, yarısı A yarısı B
      const rxnPattern = (i, count) => {
        const [vx,vy] = randVel(5);
        return { x: Math.random()*(W-20)+10, y: Math.random()*(H-20)+10, vx, vy, ptype: i < count/2 ? TYPE_A : TYPE_B };
      };
      const [nn,nr]=res();
      addParticles(nn, SECTOR_NORMAL, rxnPattern);
      addParticles(nr, SECTOR_REVERSE, rxnPattern);
      cfg.mode = nr>0 && nn===0 ? "reverse" : nr>0 ? "mixed_physical" : "normal";
      cfg.coup = nr>0 && nn>0 ? 0.1 : 0;
      break;
    }
    case "mixed_w": {
      cfg.pCntNorm=60; cfg.pCntRev=60; cfg.coup=0.1;
      // Dağılım: reverse sol, normal sağ
      const [nn,nr]=res();
      addParticles(nr, SECTOR_REVERSE, () => {
        const [vx,vy] = randVel(4);
        return { x: Math.random()*(W/2-20)+10, y: Math.random()*(H-20)+10, vx, vy };
      });
      addParticles(nn, SECTOR_NORMAL, () => {
        const [vx,vy] = randVel(4);
        return { x: W/2+10+Math.random()*(W/2-20), y: Math.random()*(H-20)+10, vx, vy };
      });
      cfg.mode = "mixed_physical";
      break;
    }
    case "mixed_d": {
      cfg.pCntNorm=80; cfg.pCntRev=40; cfg.coup=0.6;
      // Dağılım: reverse merkez halka, normal dağınık
      const [nn,nr]=res();
      addParticles(nr, SECTOR_REVERSE, (i, count) => {
        const a=(2*Math.PI*i)/(count||1), r=30+Math.random()*40;
        const [vx,vy] = randVel(2);
        return { x: W/2+r*Math.cos(a), y: H/2+r*Math.sin(a), vx, vy };
      });
      addParticles(nn, SECTOR_NORMAL, () => {
        const [vx,vy] = randVel(6);
        return { x: Math.random()*(W-20)+10, y: Math.random()*(H-20)+10, vx, vy };
      });
      cfg.mode = "mixed_physical";
      break;
    }
    case "partition": {
      cfg.pCntNorm=100; cfg.pCntRev=0;
      cfg.walls=[{x1:W/2,y1:0,x2:W/2,y2:H}]; cfg.wallSolidity=1.0;
      // Dağılım: sol sıcak, sağ soğuk (duvarla ayrılmış)
      const partPattern = (i, count) => {
        const hot = i < count/2;
        const [vx,vy] = randVel(hot ? 7 : 1.5);
        return { x: hot ? Math.random()*(W/2-20)+10 : W/2+10+Math.random()*(W/2-20), y: Math.random()*(H-20)+10, vx, vy, ptype: hot ? TYPE_A : TYPE_B };
      };
      const [nn,nr]=res();
      addParticles(nn, SECTOR_NORMAL, partPattern);
      addParticles(nr, SECTOR_REVERSE, partPattern);
      cfg.mode = nr>0 && nn===0 ? "reverse" : nr>0 ? "mixed_physical" : "normal";
      cfg.coup = nr>0 && nn>0 ? 0.1 : 0;
      break;
    }
    case "endo_exo": {
      cfg.pCntNorm=100; cfg.pCntRev=0; cfg.rxn=true;
      // Dağılım: sol FUEL+OX, sağ AB
      const endoPattern = (i, count) => {
        const q = Math.floor(count/4);
        if (i < q) { const [vx,vy]=randVel(5); return { x:Math.random()*(W/2-20)+10, y:Math.random()*(H-20)+10, vx, vy, ptype:TYPE_FUEL }; }
        if (i < 2*q) { const [vx,vy]=randVel(5); return { x:Math.random()*(W/2-20)+10, y:Math.random()*(H-20)+10, vx, vy, ptype:TYPE_OX }; }
        const [vx,vy]=randVel(7); return { x:W/2+10+Math.random()*(W/2-20), y:Math.random()*(H-20)+10, vx, vy, ptype:TYPE_AB };
      };
      const [nn,nr]=res();
      addParticles(nn, SECTOR_NORMAL, endoPattern);
      addParticles(nr, SECTOR_REVERSE, (i, count) => {
        const [vx,vy]=randVel(5);
        return { x: Math.random()*(W-20)+10, y: Math.random()*(H-20)+10, vx, vy, ptype: Math.random()<0.5?TYPE_A:TYPE_B };
      });
      cfg.mode = nr>0 && nn===0 ? "reverse" : nr>0 ? "mixed_physical" : "normal";
      cfg.coup = nr>0 && nn>0 ? 0.1 : 0;
      break;
    }
    case "therm_rev": {
      cfg.pCntNorm=0; cfg.pCntRev=100;
      cfg.thermRev=true; cfg.thermRevRate=0.5;
      // Dağılım: homojen sıcaklık, rastgele
      const thermPattern = (i, count) => {
        const temp=4+(Math.random()-0.5)*2; const [vx,vy]=randVel(temp);
        return { x: Math.random()*(W-20)+10, y: Math.random()*(H-20)+10, vx, vy };
      };
      const [nn,nr]=res();
      addParticles(nn, SECTOR_NORMAL, thermPattern);
      addParticles(nr, SECTOR_REVERSE, thermPattern);
      cfg.mode = nn>0 ? "mixed_physical" : "reverse";
      cfg.coup = nn>0 ? 0.05 : 0;
      cfg.revMode = "dynamic";
      break;
    }
    case "therm_mixed": {
      cfg.pCntNorm=60; cfg.pCntRev=60; cfg.coup=0.05;
      cfg.thermRev=true; cfg.thermRevRate=0.5; cfg.revMode="dynamic";
      // Dağılım: normal sol, reverse sağ, homojen sıcaklık
      const [nn,nr]=res();
      addParticles(nn, SECTOR_NORMAL, () => {
        const temp=4+(Math.random()-0.5)*1; const [vx,vy]=randVel(temp);
        return { x: Math.random()*(W/2-30)+15, y: Math.random()*(H-20)+10, vx, vy };
      });
      addParticles(nr, SECTOR_REVERSE, () => {
        const temp=4+(Math.random()-0.5)*1; const [vx,vy]=randVel(temp);
        return { x: W/2+15+Math.random()*(W/2-30), y: Math.random()*(H-20)+10, vx, vy };
      });
      cfg.mode = "mixed_physical";
      break;
    }
    case "full_rev": {
      cfg.pCntNorm=0; cfg.pCntRev=100;
      cfg.thermRev=true; cfg.thermRevRate=0.5;
      cfg.spatialRev=true; cfg.spatialRevMode="cluster"; cfg.spatialHeatMode="heat";
      // Dağılım: homojen, dağınık
      const fullRevPattern = (i, count) => {
        const temp=4+(Math.random()-0.5)*1.5; const [vx,vy]=randVel(temp);
        return { x: Math.random()*(W-20)+10, y: Math.random()*(H-20)+10, vx, vy };
      };
      const [nn,nr]=res();
      addParticles(nn, SECTOR_NORMAL, fullRevPattern);
      addParticles(nr, SECTOR_REVERSE, fullRevPattern);
      cfg.mode = nn>0 ? "mixed_physical" : "reverse";
      cfg.coup = nn>0 ? 0.05 : 0;
      cfg.revMode = "dynamic";
      break;
    }
    case "full_mixed": {
      cfg.pCntNorm=60; cfg.pCntRev=60; cfg.coup=0.05;
      cfg.thermRev=true; cfg.thermRevRate=0.5; cfg.revMode="dynamic";
      cfg.spatialRev=true; cfg.spatialRevMode="cluster"; cfg.spatialHeatMode="heat";
      // Dağılım: normal sol küme (sıcak-soğuk), reverse sağ dağınık
      const [nn,nr]=res();
      addParticles(nn, SECTOR_NORMAL, (i, count) => {
        const hot=i<count/2; const temp=hot?8:1.5; const [vx,vy]=randVel(temp);
        const cx=W*0.15, cy=H*0.5;
        return { x: Math.max(6,Math.min(W/2-10,cx+(Math.random()-0.5)*70)), y: Math.max(6,Math.min(H-6,cy+(Math.random()-0.5)*60)), vx, vy };
      });
      addParticles(nr, SECTOR_REVERSE, () => {
        const temp=4+(Math.random()-0.5)*1; const [vx,vy]=randVel(temp);
        return { x: W/2+10+Math.random()*(W/2-20), y: Math.random()*(H-20)+10, vx, vy };
      });
      cfg.mode = "mixed_physical";
      break;
    }
    default: return makePreset("hot_cold",W,H,nNorm,nRev);
    case "fusion": {
      cfg.pCntNorm=150; cfg.pCntRev=0; cfg.mode="normal"; cfg.nucRxn=true; cfg.nucHURatio=0; cfg.nucNPct=0;
      const [nn,nr]=res();
      addParticles(nn, SECTOR_NORMAL, () => {
        const [vx,vy]=randVel(9);
        return { x: W/2+(Math.random()-0.5)*80, y: H/2+(Math.random()-0.5)*60, vx, vy, ptype: TYPE_H };
      });
      addParticles(nr, SECTOR_REVERSE, () => {
        const [vx,vy]=randVel(9);
        return { x: W/2+(Math.random()-0.5)*80, y: H/2+(Math.random()-0.5)*60, vx, vy, ptype: TYPE_H };
      });
      cfg.mode = nr>0 && nn===0 ? "reverse" : nr>0 ? "mixed_physical" : "normal";
      cfg.coup = nr>0 && nn>0 ? 0.1 : 0;
      break;
    }
    case "fission": {
      cfg.pCntNorm=80; cfg.pCntRev=0; cfg.mode="normal"; cfg.nucRxn=true; cfg.nucHURatio=1; cfg.nucNPct=0.1;
      const [nn,nr]=res();
      const nU = Math.floor((nn||80) * 0.9);
      const nNeutron = (nn||80) - nU;
      addParticles(nU, SECTOR_NORMAL, () => {
        const [vx,vy]=randVel(2);
        return { x: W/2+(Math.random()-0.5)*60, y: H/2+(Math.random()-0.5)*50, vx, vy, ptype: TYPE_U };
      });
      addParticles(nNeutron, SECTOR_NORMAL, () => {
        const [vx,vy]=randVel(6);
        return { x: Math.random()*(W-20)+10, y: Math.random()*(H-20)+10, vx, vy, ptype: TYPE_N };
      });
      addParticles(nr, SECTOR_REVERSE, () => {
        const [vx,vy]=randVel(3);
        return { x: Math.random()*(W-20)+10, y: Math.random()*(H-20)+10, vx, vy, ptype: TYPE_U };
      });
      cfg.mode = nr>0 && nn===0 ? "reverse" : nr>0 ? "mixed_physical" : "normal";
      cfg.coup = nr>0 && nn>0 ? 0.1 : 0;
      break;
    }
  }

  cfg.ps = ps;
  const [fnn, fnr] = res();
  cfg.pCntNorm = fnn;
  cfg.pCntRev = fnr;
  return cfg;
}

// ─── REVERSE PLAYBACK ──────────────────────────────────────────
const REV_FRAME_COUNT = 1500; // 1500 kare = ~25 saniye

function prepReverse(particles, W, H) {
  const snaps = [];
  const cl = particles.map(p => ({...p}));
  snaps.push(cl.map(p => ({...p})));
  for (let i = 0; i < REV_FRAME_COUNT; i++) {
    physicsStep(cl, W, H, 1/60, "normal", 1.0, 0, []); // tam elastik
    snaps.push(cl.map(p => ({...p})));
  }
  snaps.reverse();
  return snaps;
}

// ─── DUVAR ALAN SICAKLIKLARI ──────────────────────────────────
function applyWallTemps(ps, walls, leftTemp, rightTemp) {
  if (!walls || walls.length === 0) return;
  const w = walls[0];
  if (Math.abs(w.x1 - w.x2) > 2) return;
  const wx = (w.x1 + w.x2) / 2;
  const lSpd = 1 + (typeof leftTemp === "number" ? leftTemp : 0.5) * 9;
  const rSpd = 1 + (typeof rightTemp === "number" ? rightTemp : 0.5) * 9;
  for (const p of ps) {
    const spd = p.x < wx ? lSpd : rSpd;
    const [vx,vy] = randVel(spd);
    p.vx = vx; p.vy = vy;
  }
}

function applyWallPartition(ps, walls, leftNormPct, leftRevPct, W, H) {
  if (!walls || walls.length === 0) return;
  const w = walls[0];
  if (Math.abs(w.x1 - w.x2) > 2) return;
  const wx = (w.x1 + w.x2) / 2;
  const lnp = typeof leftNormPct === "number" ? leftNormPct : 0.5;
  const lrp = typeof leftRevPct === "number" ? leftRevPct : 0.5;
  const norms = ps.filter(p => p.sector === SECTOR_NORMAL);
  const revs = ps.filter(p => p.sector === SECTOR_REVERSE);
  const nLeft = Math.round(norms.length * lnp);
  const rLeft = Math.round(revs.length * lrp);
  for (let i = 0; i < norms.length; i++) {
    const p = norms[i];
    if (i < nLeft) { p.x = Math.random() * (wx - 12) + 6; }
    else { p.x = wx + 6 + Math.random() * (W - wx - 12); }
    p.y = Math.random() * (H - 12) + 6;
  }
  for (let i = 0; i < revs.length; i++) {
    const p = revs[i];
    if (i < rLeft) { p.x = Math.random() * (wx - 12) + 6; }
    else { p.x = wx + 6 + Math.random() * (W - wx - 12); }
    p.y = Math.random() * (H - 12) + 6;
  }
}

// ─── SICAK/SOĞUK ORAN ────────────────────────────────────────
function applyHotColdRatio(ps, ratio) {
  // ratio: 0=hepsi soğuk, 1=hepsi sıcak, 0.5=yarı yarıya
  const r = typeof ratio === "number" ? ratio : 0.5;
  const nHot = Math.round(ps.length * r);
  // Parçacıkları hızlarına göre sırala (yavaştan hızlıya)
  const sorted = [...ps].sort((a,b) => (a.vx*a.vx+a.vy*a.vy) - (b.vx*b.vx+b.vy*b.vy));
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (i < sorted.length - nHot) {
      // Soğuk: hızı düşür
      const [vx,vy] = randVel(1);
      p.vx = vx; p.vy = vy;
    } else {
      // Sıcak: hızı artır
      const [vx,vy] = randVel(8);
      p.vx = vx; p.vy = vy;
    }
  }
}

// ─── REAKSİYON TOHUMU ─────────────────────────────────────────
function seedReactants(ps, ratio, productRatio, fraction) {
  const r = typeof ratio === "number" ? ratio : 0.5;
  const pr = typeof productRatio === "number" ? productRatio : 0;
  const frac = typeof fraction === "number" ? fraction : 1;
  
  const eligible = ps.filter(p => p.ptype <= TYPE_PRODUCT && p.ptype !== TYPE_FUEL && p.ptype !== TYPE_OX);
  if (eligible.length < 2) return;
  
  // fraction kadar parçacık kimyaya ayrılır, geri kalanı TYPE_A kalır (nükleer için)
  const nChem = Math.round(eligible.length * frac);
  const chemPs = eligible.slice(0, nChem);
  
  const nProduct = Math.round(chemPs.length * pr);
  const nReactant = chemPs.length - nProduct;
  
  let iProd = 0;
  for (const p of chemPs) {
    if (iProd < nProduct) { p.ptype = TYPE_AB; iProd++; }
  }
  
  const reactants = chemPs.filter(p => p.ptype !== TYPE_AB);
  const targetB = Math.round(reactants.length * r);
  let iB = 0;
  for (const p of reactants) {
    if (iB < targetB) { p.ptype = TYPE_B; iB++; }
    else { p.ptype = TYPE_A; }
  }
}

function seedNuclear(ps, huRatio, nPct) {
  const hr = typeof huRatio === "number" ? huRatio : 0.5;
  const np = typeof nPct === "number" ? nPct : 0.1;
  // Sadece TYPE_A (kimyasal tarafından kullanılmamış) parçacıkları dönüştür
  const eligible = ps.filter(p => p.ptype === TYPE_A);
  if (eligible.length < 2) return;
  const total = eligible.length;
  const nNeutron = Math.max(0, Math.round(total * np));
  const remaining = total - nNeutron;
  const nU = Math.round(remaining * hr);
  const nH = remaining - nU;
  let iH = 0, iU = 0, iN = 0;
  for (const p of eligible) {
    if (iH < nH) { p.ptype = TYPE_H; p.mass = 0.5; p.radius = 2.5; iH++; }
    else if (iU < nU) { p.ptype = TYPE_U; p.mass = 4; p.radius = 5; iU++; }
    else if (iN < nNeutron) { p.ptype = TYPE_N; p.mass = 0.3; p.radius = 2; p.vx = (Math.random()-0.5)*12; p.vy = (Math.random()-0.5)*12; iN++; }
  }
}

// ─── COMPONENT ─────────────────────────────────────────────────
export default function ThermoSim() {
  const canvasRef = useRef(null);
  const S = useRef({
    ps:[], frame:0, run:false, mode:"normal", rest:.95, coup:0,
    rxn:false, nucRxn:false, isrxn:false, eam:1, nucEam:1, rxnDh:0, rxnBal:1, rxnRad:12, rxnABRatio:0.5, rxnProductRatio:0,
    nucDh:0, nucBal:1, nucRad:12, nucHURatio:0.5, nucNPct:0.1, hotColdRatio:0.5, spd:1,
    walls:[], wallSolidity:1.0, wallThermalPerm:0.0, wallLeftTemp:0.5, wallRightTemp:0.5, wallLeftNormPct:0.5, wallLeftRevPct:0.5, showVel:false, showTBg:true, showEMap:false,
    revF:null, revI:0, revLoop:true, revMode:"playback",
    thermRev:false, thermRevRate:0.5, thermClamp:0.5,
    spatialRev:false, spatialRevRate:0.2, spatialRevMode:"cluster", spatialHeatMode:"heat",
    sH:[], sN:[], sR:[], eH:[], kH:[],
    rxnT:0, pCntNorm:60, pCntRev:60, lastP:"hot_cold", spdAcc:0, spdRaw:333, timeReversed:false
  });
  const raf = useRef(null);
  const [, tick] = useState(0);
  const bump = () => tick(c => c + 1);
  const [tab, setTab] = useState("ctrl");
  const tabRef = useRef("ctrl");
  const [simW, setSimW] = useState(360);
  const simH = Math.round(simW * 0.65);

  useEffect(() => {
    const resize = () => setSimW(Math.min(window.innerWidth - 16, 600));
    resize(); window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const genReverse = useCallback((particles, w, h) => {
    const s = S.current;
    s.revF = prepReverse(particles, w, h);
    s.revI = 0;
    s.ps = s.revF[0].map(p => ({...p}));
  }, []);

  // Snapshot: senaryo+mod seçiminden sonraki ayar durumunu saklar
  // ⏪ buna döner, 🔄 sadece parçacıkları yeniler
  function saveSnapshot() {
    const s = S.current;
    s._snapshot = {
      lastP: s.lastP, mode: s.mode, rxn: s.rxn, nucRxn: s.nucRxn, rxnDh: s.rxnDh, rxnBal: s.rxnBal, rxnRad: s.rxnRad, rxnABRatio: s.rxnABRatio, rxnProductRatio: s.rxnProductRatio, hotColdRatio: s.hotColdRatio, nucDh: s.nucDh, nucBal: s.nucBal, nucRad: s.nucRad, nucHURatio: s.nucHURatio, nucNPct: s.nucNPct, coup: s.coup, rest: s.rest, eam: s.eam, nucEam: s.nucEam,
      walls: s.walls.map(w=>({...w})), wallSolidity: s.wallSolidity, wallThermalPerm: s.wallThermalPerm, wallLeftTemp: s.wallLeftTemp, wallRightTemp: s.wallRightTemp, wallLeftNormPct: s.wallLeftNormPct, wallLeftRevPct: s.wallLeftRevPct,
      thermRev: s.thermRev, thermRevRate: s.thermRevRate, thermClamp: s.thermClamp,
      spatialRev: s.spatialRev, spatialRevRate: s.spatialRevRate,
      spatialRevMode: s.spatialRevMode, spatialHeatMode: s.spatialHeatMode,
      revMode: s.revMode, pCntNorm: s.pCntNorm, pCntRev: s.pCntRev,
    };
  }

  const load = useCallback((name) => {
    const s = S.current;
    const h = Math.round(simW * 0.65);
    // null, null → makePreset kendi default parçacık sayılarını kullanır
    const pr = makePreset(name, simW, h, null, null);

    // Parçacıklar
    s.ps = pr.ps;
    s.frame = 0;
    s.sH=[]; s.sN=[]; s.sR=[]; s.eH=[]; s.kH=[];
    s.rxnT = 0;
    s.revF = null; s.revI = 0;
    s.lastP = name; s.run = false; s.timeReversed = false;

    // TÜM kontrol state'lerini preset'ten uygula
    s.mode = pr.mode;
    s.rxn = pr.rxn;
    s.nucRxn = pr.nucRxn;
    s.rxnDh = pr.rxnDh;
    s.rxnBal = pr.rxnBal;
    s.rxnRad = pr.rxnRad;
    s.rxnABRatio = pr.rxnABRatio;
    s.rxnProductRatio = pr.rxnProductRatio;
    s.hotColdRatio = pr.hotColdRatio;
    s.nucDh = pr.nucDh; s.nucBal = pr.nucBal; s.nucRad = pr.nucRad; s.nucHURatio = pr.nucHURatio; s.nucNPct = pr.nucNPct;
    s.coup = pr.coup;
    s.walls = pr.walls;
    s.wallSolidity = pr.wallSolidity;
    s.wallThermalPerm = pr.wallThermalPerm;
    s.wallLeftTemp = pr.wallLeftTemp; s.wallRightTemp = pr.wallRightTemp;
    s.wallLeftNormPct = pr.wallLeftNormPct; s.wallLeftRevPct = pr.wallLeftRevPct;
    s.thermRev = pr.thermRev;
    s.thermRevRate = pr.thermRevRate;
    s.thermClamp = pr.thermClamp;
    s.spatialRev = pr.spatialRev;
    s.spatialRevRate = pr.spatialRevRate;
    s.spatialRevMode = pr.spatialRevMode;
    s.spatialHeatMode = pr.spatialHeatMode;
    s.revMode = pr.revMode;

    // Parçacık sayı slider'larını güncelle
    s.pCntNorm = pr.pCntNorm;
    s.pCntRev = pr.pCntRev;

    // _wallSide temizle
    for (const p of s.ps) delete p._wallSide;

    // Reverse playback hazırla
    if (s.mode === "reverse" && s.revMode === "playback") {
      genReverse(s.ps, simW, h);
    }
    // Snapshot kaydet: senaryo yükleme sonrası referans noktası
    saveSnapshot();
    bump();
  }, [simW, genReverse]);

  useEffect(() => { load("hot_cold"); }, [load]);

  // ─── SOFT RESET: Sadece parçacık dağılımını yenile, ayarları koru ──
  const softReset = useCallback(() => {
    const s = S.current;
    const h = Math.round(simW * 0.65);
    // Mevcut ayarları sakla
    const saved = {
      mode: s.mode, rxn: s.rxn, nucRxn: s.nucRxn, rxnDh: s.rxnDh, rxnBal: s.rxnBal, rxnRad: s.rxnRad, rxnABRatio: s.rxnABRatio, rxnProductRatio: s.rxnProductRatio, hotColdRatio: s.hotColdRatio, nucDh: s.nucDh, nucBal: s.nucBal, nucRad: s.nucRad, nucHURatio: s.nucHURatio, nucNPct: s.nucNPct, coup: s.coup,
      walls: s.walls, wallSolidity: s.wallSolidity, wallThermalPerm: s.wallThermalPerm, wallLeftTemp: s.wallLeftTemp, wallRightTemp: s.wallRightTemp, wallLeftNormPct: s.wallLeftNormPct, wallLeftRevPct: s.wallLeftRevPct,
      thermRev: s.thermRev, thermRevRate: s.thermRevRate, thermClamp: s.thermClamp,
      spatialRev: s.spatialRev, spatialRevRate: s.spatialRevRate,
      spatialRevMode: s.spatialRevMode, spatialHeatMode: s.spatialHeatMode,
      revMode: s.revMode, rest: s.rest, eam: s.eam, nucEam: s.nucEam, isrxn: s.isrxn,
      spd: s.spd, spdRaw: s.spdRaw,
      showVel: s.showVel, showTBg: s.showTBg, showEMap: s.showEMap,
    };

    // Preset'ten sadece parçacıkları al (mevcut sayılarla)
    const pr = makePreset(s.lastP || "hot_cold", simW, h, s.pCntNorm, s.pCntRev);
    s.ps = pr.ps;

    // Simülasyon sayaçlarını sıfırla
    s.frame = 0;
    s.sH=[]; s.sN=[]; s.sR=[]; s.eH=[]; s.kH=[];
    s.rxnT = 0;
    s.revF = null; s.revI = 0;
    s.run = false;
    s.spdAcc = 0;
    s.timeReversed = false;

    // Saklanan ayarları geri yükle (ayarlar DEĞİŞMEZ)
    Object.assign(s, saved);

    // Reaksiyon açıksa reaktan türlerini ekle
    { const bothOn=s.rxn&&s.nucRxn; if(s.rxn) seedReactants(s.ps, s.rxnABRatio, s.rxnProductRatio, bothOn?0.5:1); if(s.nucRxn) seedNuclear(s.ps, s.nucHURatio, s.nucNPct); } applyHotColdRatio(s.ps, s.hotColdRatio); if(s.walls.length>0){ applyWallPartition(s.ps, s.walls, s.wallLeftNormPct, s.wallLeftRevPct, simW, Math.round(simW*0.65)); applyWallTemps(s.ps, s.walls, s.wallLeftTemp, s.wallRightTemp); }

    // _wallSide temizle
    for (const p of s.ps) delete p._wallSide;

    // Reverse playback hazırla
    if (s.mode === "reverse" && s.revMode === "playback") {
      genReverse(s.ps, simW, h);
    }
    bump();
  }, [simW, genReverse]);

  // ─── Animation loop ─────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = simW, H = Math.round(simW * 0.65), GH = 70;

    const loop = () => {
      const s = S.current;
      canvas.width = W; canvas.height = H + GH + 8;

      if (s.run && s.spd > 0) {
        // Accumulator: spd=0.25 → her 4 karede 1 adım, spd=3 → her karede 3 adım
        s.spdAcc += s.spd;
        while (s.spdAcc >= 1) {
          s.spdAcc -= 1;

          if (s.mode === "reverse" && s.revMode === "playback" && s.revF) {
            // ── Playback reverse ──
            s.revI++;
            if (s.revI >= s.revF.length) {
              if (s.revLoop) { s.revI = 0; }
              else { s.revI = s.revF.length - 1; s.run = false; }
            }
            s.ps = s.revF[s.revI].map(p => ({...p}));

          } else if (s.mode === "reverse" && s.revMode === "dynamic") {
            const tr = s.timeReversed;
            for (const p of s.ps) { p.vx *= -1; p.vy *= -1; }
            physicsStep(s.ps, W, H, 1/60, "normal", 1.0, 0, s.walls, s.thermRev, s.thermRevRate, s.wallSolidity, s.thermClamp, tr);
            for (const p of s.ps) { p.vx *= -1; p.vy *= -1; }
            s.rxnT += rxnStep(s.ps, 1/60, "reverse", s.rxnRad, s.rxn, false, s.eam, s.isrxn, tr, s.rxnDh, s.rxnBal);
            s.rxnT += rxnStep(s.ps, 1/60, "reverse", s.nucRad, false, s.nucRxn, s.nucEam, s.isrxn, tr, s.nucDh, s.nucBal);
            if (s.thermRev) antiFourierStep(s.ps, W, H, 1/60, s.thermRevRate, s.thermClamp, tr);
            if (s.spatialRev) antiDiffusionStep(s.ps, W, H, 1/60, s.spatialRevRate, s.spatialRevMode, s.walls, s.wallSolidity, s.spatialHeatMode, tr);
            enforceWalls(s.ps, s.walls, s.wallSolidity, 0.98);
            wallThermalTransfer(s.ps, s.walls, 1/60, s.wallThermalPerm, tr);

          } else {
            const tr = s.timeReversed;
            physicsStep(s.ps, W, H, 1/60, s.mode, s.rest, s.coup, s.walls, s.thermRev, s.thermRevRate, s.wallSolidity, s.thermClamp, tr);
            s.rxnT += rxnStep(s.ps, 1/60, s.mode, s.rxnRad, s.rxn, false, s.eam, s.isrxn, tr, s.rxnDh, s.rxnBal);
            s.rxnT += rxnStep(s.ps, 1/60, s.mode, s.nucRad, false, s.nucRxn, s.nucEam, s.isrxn, tr, s.nucDh, s.nucBal);
            if (s.thermRev) {
              antiFourierStep(s.ps, W, H, 1/60, s.thermRevRate, s.thermClamp, tr);
            }
            if (s.spatialRev) {
              antiDiffusionStep(s.ps, W, H, 1/60, s.spatialRevRate, s.spatialRevMode, s.walls, s.wallSolidity, s.spatialHeatMode, tr);
            }
            enforceWalls(s.ps, s.walls, s.wallSolidity, 0.98);
            wallThermalTransfer(s.ps, s.walls, 1/60, s.wallThermalPerm, tr);
          }

          s.frame++;
          if (s.frame % 3 === 0) {
            const aS = calcEntropy(s.ps, W, H);
            const nP = s.ps.filter(p => p.sector === SECTOR_NORMAL);
            const rP = s.ps.filter(p => p.sector === SECTOR_REVERSE);
            s.sH.push(aS); s.sN.push(nP.length>1?calcEntropy(nP,W,H):0); s.sR.push(rP.length>1?calcEntropy(rP,W,H):0);
            let tE=0,tK=0;for(const p of s.ps){const ke=.5*p.mass*(p.vx*p.vx+p.vy*p.vy);tK+=ke;tE+=ke+p.energy;}
            s.eH.push(tE); s.kH.push(tK);
            const mx=300;if(s.sH.length>mx){s.sH.splice(0,s.sH.length-mx);s.sN.splice(0,s.sN.length-mx);s.sR.splice(0,s.sR.length-mx);s.eH.splice(0,s.eH.length-mx);s.kH.splice(0,s.kH.length-mx);}
          }
        }
      }

      // ─── DRAW ──────────────────────────────────────────
      ctx.fillStyle="#0a0a12"; ctx.fillRect(0,0,W,H+GH+8);
      ctx.fillStyle="#0c0c16"; ctx.fillRect(0,0,W,H);

      if (s.showTBg && s.ps.length > 0) {
        const gr=12,cw=W/gr,ch=H/gr,tg=new Float64Array(gr*gr),cg=new Float64Array(gr*gr);
        for(const p of s.ps){const cx=Math.min(Math.max(Math.floor(p.x/W*gr),0),gr-1),cy=Math.min(Math.max(Math.floor(p.y/H*gr),0),gr-1);tg[cx*gr+cy]+=.5*(p.vx*p.vx+p.vy*p.vy)/p.mass;cg[cx*gr+cy]++;}
        for(let ix=0;ix<gr;ix++) for(let iy=0;iy<gr;iy++){const idx=ix*gr+iy;if(cg[idx]>0){const[r,g,b]=tempToRGB(tg[idx]/cg[idx]);ctx.fillStyle=`rgba(${r},${g},${b},0.18)`;ctx.fillRect(ix*cw,iy*ch,cw+1,ch+1);}}
      }
      if (s.showEMap && s.ps.length > 0) {
        const gr=6,cw=W/gr,ch=H/gr,dn=new Float64Array(gr*gr);
        for(const p of s.ps){dn[Math.min(Math.max(Math.floor(p.x/W*gr),0),gr-1)*gr+Math.min(Math.max(Math.floor(p.y/H*gr),0),gr-1)]++;}
        const ex=s.ps.length/(gr*gr);
        for(let ix=0;ix<gr;ix++) for(let iy=0;iy<gr;iy++){const dv=Math.abs(dn[ix*gr+iy]-ex)/Math.max(ex,1),a=Math.min(dv*.15,.35);if(a>.02){ctx.fillStyle=`rgba(255,100,50,${a})`;ctx.fillRect(ix*cw,iy*ch,cw+1,ch+1);}}
      }
      const wallAlpha = Math.max(0.1, s.wallSolidity);
      const wallWidth = 1 + Math.round(s.wallSolidity * 3);
      ctx.strokeStyle=`rgba(119,136,170,${wallAlpha})`;ctx.lineWidth=wallWidth;
      for(const w of s.walls){ctx.beginPath();ctx.moveTo(w.x1,w.y1);ctx.lineTo(w.x2,w.y2);ctx.stroke();
        if(s.wallSolidity<1){ctx.fillStyle=`rgba(200,200,255,0.5)`;ctx.font="8px monospace";ctx.fillText((s.wallSolidity*100).toFixed(0)+"%",(w.x1+w.x2)/2-8,(w.y1+w.y2)/2);}
      }
      ctx.strokeStyle="#222238";ctx.lineWidth=1;ctx.strokeRect(.5,.5,W-1,H-1);

      for (const p of s.ps) {
        const ke=.5*(p.vx*p.vx+p.vy*p.vy),col=tempToColor(ke),isR=p.sector===SECTOR_REVERSE;
        if(p.flash>0){ctx.beginPath();ctx.arc(p.x,p.y,p.radius*2.5,0,Math.PI*2);ctx.fillStyle=`rgba(255,255,180,${p.flash/.3*.4})`;ctx.fill();}
        ctx.fillStyle=col;
        if(isR){ctx.beginPath();ctx.moveTo(p.x,p.y-p.radius-1);ctx.lineTo(p.x+p.radius+1,p.y);ctx.lineTo(p.x,p.y+p.radius+1);ctx.lineTo(p.x-p.radius-1,p.y);ctx.closePath();ctx.fill();ctx.strokeStyle="rgba(180,100,255,.7)";ctx.lineWidth=1;ctx.stroke();}
        else{ctx.beginPath();ctx.arc(p.x,p.y,p.radius,0,Math.PI*2);ctx.fill();ctx.strokeStyle={[TYPE_A]:"#66b4ff",[TYPE_B]:"#ffa050",[TYPE_AB]:"#b466ff",[TYPE_FUEL]:"#ff5050",[TYPE_OX]:"#50cc50",[TYPE_PRODUCT]:"#cccc66",[TYPE_H]:"#40d0ff",[TYPE_HE]:"#ffee44",[TYPE_U]:"#44ff88",[TYPE_FR]:"#ff6688",[TYPE_N]:"#ffffff"}[p.ptype]||"#aaa";ctx.lineWidth=1;ctx.stroke();}
        if(s.showVel){ctx.strokeStyle="rgba(180,180,80,.4)";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(p.x+p.vx*.2,p.y+p.vy*.2);ctx.stroke();}
      }

      // Reverse progress bar
      if (s.mode==="reverse" && s.revMode==="playback" && s.revF) {
        const prog=s.revI/Math.max(s.revF.length-1,1), barY=H-5;
        ctx.fillStyle="rgba(0,0,0,0.6)";ctx.fillRect(0,barY,W,5);
        ctx.fillStyle="#5555cc";ctx.fillRect(0,barY,W*prog,5);
        ctx.fillStyle="rgba(200,200,255,0.8)";ctx.font="bold 10px monospace";
        const secLeft=((s.revF.length-s.revI)/60).toFixed(0);
        ctx.fillText(`⏪ ${Math.round(prog*100)}%  ${secLeft}s`,4,barY-3);
      }
      if (s.mode==="reverse" && s.revMode==="dynamic" && s.run) {
        ctx.fillStyle="rgba(180,100,255,0.2)";ctx.fillRect(0,0,W,3);
        ctx.fillStyle="rgba(200,200,255,0.7)";ctx.font="9px monospace";ctx.fillText("⚡ Dinamik Reverse",4,12);
      }

      // Graphs
      const gy=H+4,gw=W/2-4,gh=GH;
      drawG(ctx,2,gy,gw,gh,"Entropi",[s.sH,s.sN,s.sR],["#ddd","#66b4ff","#b466ff"]);
      drawG(ctx,W/2+2,gy,gw,gh,"Enerji",[s.eH,s.kH],["#ddd","#50dc78"]);

      // React UI güncelleme: istatistik sekmesi canlı kalması için
      // React UI: istatistik sekmesi açıkken, hıza göre ölçekli güncelleme
      if (s.run && tabRef.current === "stat") {
        const now = performance.now();
        const bumpMs = s.spd <= 1 ? 200 : s.spd <= 10 ? 400 : 800;
        if (!s._lastBump || now - s._lastBump > bumpMs) {
          s._lastBump = now;
          bump();
        }
      }

      raf.current=requestAnimationFrame(loop);
    };
    raf.current=requestAnimationFrame(loop);
    return()=>{if(raf.current)cancelAnimationFrame(raf.current);};
  },[simW]);

  function drawG(ctx,x,y,w,h,title,series,colors){
    ctx.fillStyle="#0e0e1a";ctx.fillRect(x,y,w,h);ctx.strokeStyle="#1a1a2a";ctx.lineWidth=1;ctx.strokeRect(x,y,w,h);
    ctx.fillStyle="#667";ctx.font="9px monospace";ctx.fillText(title,x+3,y+10);
    let mn=Infinity,mx=-Infinity;for(const s of series)for(const v of s){if(v<mn)mn=v;if(v>mx)mx=v;}
    if(mx-mn<.001){mn-=1;mx+=1;}const pad=(mx-mn)*.05;mn-=pad;mx+=pad;
    for(let si=0;si<series.length;si++){const d=series[si];if(d.length<2)continue;ctx.strokeStyle=colors[si];ctx.lineWidth=1;ctx.beginPath();
    for(let i=0;i<d.length;i++){const px=x+(i/(d.length-1))*w,py=y+h-4-((d[i]-mn)/(mx-mn))*(h-16);if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);}ctx.stroke();}
  }

  // ─── UI ─────────────────────────────────────────────────────
  const s=S.current;
  const modeLabels={normal:"Normal",reverse:"Ters",mixed_physical:"Karma Fiz.",mixed_cinematic:"Karma Sin."};

  const setMode=(m)=>{
    s.mode = m;

    // Parçacık sektörlerini moda göre dönüştür
    if (m === "normal") {
      for (const p of s.ps) p.sector = SECTOR_NORMAL;
      s.thermRev = false;
      s.spatialRev = false;
      s.coup = 0;
      s.revMode = "dynamic";
    } else if (m === "reverse") {
      for (const p of s.ps) p.sector = SECTOR_REVERSE;
      s.revMode = "dynamic";
      s.coup = 0;
    } else if (m === "mixed_physical") {
      const allSame = s.ps.every(p => p.sector === s.ps[0]?.sector);
      if (allSame && s.ps.length > 1) {
        const half = Math.floor(s.ps.length / 2);
        for (let i = 0; i < s.ps.length; i++) {
          s.ps[i].sector = i < half ? SECTOR_NORMAL : SECTOR_REVERSE;
        }
      }
      s.coup = Math.max(s.coup, 0.1);
      s.revMode = "dynamic";
    } else if (m === "mixed_cinematic") {
      const allSame = s.ps.every(p => p.sector === s.ps[0]?.sector);
      if (allSame && s.ps.length > 1) {
        const half = Math.floor(s.ps.length / 2);
        for (let i = 0; i < s.ps.length; i++) {
          s.ps[i].sector = i < half ? SECTOR_NORMAL : SECTOR_REVERSE;
        }
      }
      s.coup = Math.max(s.coup, 0.3);
      s.revMode = "dynamic";
    }

    // Parçacık sayı slider'larını gerçek dağılıma göre güncelle
    s.pCntNorm = s.ps.filter(p => p.sector === SECTOR_NORMAL).length;
    s.pCntRev = s.ps.filter(p => p.sector === SECTOR_REVERSE).length;

    // NOT: lastP değiştirilMEZ — senaryo aynı kalır, sadece mod değişir
    // Snapshot kaydet: mod değişimi sonrası referans noktası
    saveSnapshot();

    if (m === "reverse" && s.revMode === "playback") {
      genReverse(s.ps, simW, simH);
    }
    bump();
  };

  const nTot=s.ps.length,nN=s.ps.filter(p=>p.sector===SECTOR_NORMAL).length,nR=nTot-nN;
  let tE=0,tK=0;for(const p of s.ps){const ke=.5*p.mass*(p.vx*p.vx+p.vy*p.vy);tK+=ke;tE+=ke+p.energy;}
  const avgT=nTot>0?tK/nTot:0;
  const dec=decoherence(s.ps,simW,simH);

  // Parçacık tipi dökümü
  const typeNames={[TYPE_A]:"A",[TYPE_B]:"B",[TYPE_AB]:"AB",[TYPE_FUEL]:"Fuel",[TYPE_OX]:"Ox",[TYPE_PRODUCT]:"Ürün",[TYPE_H]:"H",[TYPE_HE]:"He",[TYPE_U]:"U",[TYPE_FR]:"Fr",[TYPE_N]:"n"};
  const typeColors={[TYPE_A]:"#66b4ff",[TYPE_B]:"#ffa050",[TYPE_AB]:"#b466ff",[TYPE_FUEL]:"#ff5050",[TYPE_OX]:"#50cc50",[TYPE_PRODUCT]:"#cccc66",[TYPE_H]:"#40d0ff",[TYPE_HE]:"#ffee44",[TYPE_U]:"#44ff88",[TYPE_FR]:"#ff6688",[TYPE_N]:"#ffffff"};
  function countTypes(particles) {
    const c={};
    for(const p of particles){ c[p.ptype]=(c[p.ptype]||0)+1; }
    return c;
  }
  const normTypes=countTypes(s.ps.filter(p=>p.sector===SECTOR_NORMAL));
  const revTypes=countTypes(s.ps.filter(p=>p.sector===SECTOR_REVERSE));

  const tabBtn=(id,label)=>(
    <button key={id} onClick={()=>{setTab(id);tabRef.current=id;}}
      style={{flex:1,padding:"7px 0",background:tab===id?"#1a2a4a":"transparent",color:tab===id?"#5090ff":"#556",
        border:"none",borderBottom:tab===id?"2px solid #3070d0":"2px solid transparent",
        fontSize:10,fontWeight:600,fontFamily:"inherit",cursor:"pointer"}}>{label}</button>
  );

  return(
    <div style={{background:"#08080e",minHeight:"100vh",color:"#ccd",fontFamily:"'SF Mono','Menlo',monospace",maxWidth:600,margin:"0 auto"}}>
      <div style={{display:"flex",alignItems:"center",padding:"6px 8px",borderBottom:"1px solid #1a1a2a",gap:6}}>
        <span style={{fontSize:13,fontWeight:700,color:"#5090ff",letterSpacing:1}}>THERMOSIM v47</span>
        <span style={{fontSize:8,color:"#556",flex:1}}>Toy Model</span>
        <span style={{fontSize:8,color:"#f80",background:"#f801",padding:"2px 6px",borderRadius:3}}>⚠ Eğitimsel</span>
      </div>

      <div style={{padding:"6px 8px 0"}}>
        <canvas ref={canvasRef} width={simW} height={simH+78}
          style={{width:"100%",height:"auto",display:"block",borderRadius:4,border:"1px solid #1a1a28"}}/>
        <div style={{display:"flex",alignItems:"center",gap:4,marginTop:4}}>
          <span style={{fontSize:8,color:"#445"}}>Soğuk</span>
          <div style={{flex:1,height:5,borderRadius:3,background:"linear-gradient(90deg,#081046,#1450b4,#14a0aa,#3cc83c,#dcd61e,#e07810,#d21e0e)"}}/>
          <span style={{fontSize:8,color:"#445"}}>Sıcak</span>
        </div>
      </div>

      <div style={{display:"flex",gap:4,padding:"6px 8px"}}>
        <button onClick={()=>{s.run=!s.run;bump();}}
          style={{flex:1,padding:"10px 0",borderRadius:6,border:"none",fontFamily:"inherit",fontWeight:700,fontSize:12,cursor:"pointer",
            background:s.run?"#a03030":"#208840",color:"#fff"}}>
          {s.run?"⏸ Duraklat":"▶ Başlat"}
        </button>
        <button onClick={()=>{
          s.run=false;
          if(s.mode==="reverse"&&s.revMode==="playback"&&s.revF){s.revI=Math.min(s.revI+1,s.revF.length-1);s.ps=s.revF[s.revI].map(p=>({...p}));}
          else if(s.mode==="reverse"&&s.revMode==="dynamic"){const tr=s.timeReversed;for(const p of s.ps){p.vx*=-1;p.vy*=-1;}physicsStep(s.ps,simW,simH,1/60,"normal",1,0,s.walls,s.thermRev,s.thermRevRate,s.wallSolidity,s.thermClamp,tr);for(const p of s.ps){p.vx*=-1;p.vy*=-1;}s.rxnT+=rxnStep(s.ps,1/60,"reverse",s.rxnRad,s.rxn,false,s.eam,s.isrxn,tr,s.rxnDh,s.rxnBal);s.rxnT+=rxnStep(s.ps,1/60,"reverse",s.nucRad,false,s.nucRxn,s.nucEam,s.isrxn,tr,s.nucDh,s.nucBal);if(s.thermRev)antiFourierStep(s.ps,simW,simH,1/60,s.thermRevRate,s.thermClamp,tr);if(s.spatialRev)antiDiffusionStep(s.ps,simW,simH,1/60,s.spatialRevRate,s.spatialRevMode,s.walls,s.wallSolidity,s.spatialHeatMode,tr);enforceWalls(s.ps,s.walls,s.wallSolidity,0.98);wallThermalTransfer(s.ps,s.walls,1/60,s.wallThermalPerm,tr);}
          else{const tr=s.timeReversed;physicsStep(s.ps,simW,simH,1/60,s.mode,s.rest,s.coup,s.walls,s.thermRev,s.thermRevRate,s.wallSolidity,s.thermClamp,tr);rxnStep(s.ps,1/60,s.mode,s.rxnRad,s.rxn,false,s.eam,s.isrxn,tr,s.rxnDh,s.rxnBal);rxnStep(s.ps,1/60,s.mode,s.nucRad,false,s.nucRxn,s.nucEam,s.isrxn,tr,s.nucDh,s.nucBal);if(s.thermRev)antiFourierStep(s.ps,simW,simH,1/60,s.thermRevRate,s.thermClamp,tr);if(s.spatialRev)antiDiffusionStep(s.ps,simW,simH,1/60,s.spatialRevRate,s.spatialRevMode,s.walls,s.wallSolidity,s.spatialHeatMode,tr);enforceWalls(s.ps,s.walls,s.wallSolidity,0.98);wallThermalTransfer(s.ps,s.walls,1/60,s.wallThermalPerm,tr);}
          s.frame++;bump();
        }} style={{flex:.6,padding:"10px 0",borderRadius:6,border:"none",background:"#1e1e2e",color:"#889",fontFamily:"inherit",fontWeight:600,fontSize:11,cursor:"pointer"}}>
          Adım→
        </button>
        <button onClick={()=>softReset()}
          style={{flex:.5,padding:"10px 0",borderRadius:6,border:"none",background:"#1a2a10",color:"#ac0",fontFamily:"inherit",fontWeight:600,fontSize:11,cursor:"pointer"}}
          title="Parçacıkları yenile (ayarları koru)">🔄</button>
        <button onClick={()=>{
          // ⏳ Zaman tersleme: tüm hızları ters çevir (Hamiltonian t→-t)
          const s = S.current;
          for(const p of s.ps){p.vx*=-1;p.vy*=-1;}
          s.timeReversed = !s.timeReversed;
          bump();
        }}
          style={{flex:.5,padding:"10px 0",borderRadius:6,border:"none",
            background:S.current.timeReversed?"#302050":"#1a1a30",
            color:S.current.timeReversed?"#d8a0ff":"#88b",
            fontFamily:"inherit",fontWeight:600,fontSize:11,cursor:"pointer",
            boxShadow:S.current.timeReversed?"0 0 8px #8040c0":"none"}}
          title={S.current.timeReversed?"Zaman geriye akıyor — tekrar bas ileri dönsün":"Zamanı tersine çevir"}>
          {S.current.timeReversed?"⏳ Geri":"⏳ İleri"}</button>
        <button onClick={()=>{
          // ⏪ Snapshot'a dön: senaryo+mod seçiminden sonraki ayar durumuna sıfırla
          const s = S.current;
          const snap = s._snapshot;
          if (!snap) { load(s.lastP||"hot_cold"); return; }
          const h = Math.round(simW * 0.65);
          // Snapshot'taki ayarları geri yükle
          Object.assign(s, {
            mode: snap.mode, rxn: snap.rxn, nucRxn: snap.nucRxn, rxnDh: snap.rxnDh, rxnBal: snap.rxnBal, rxnRad: snap.rxnRad, rxnABRatio: snap.rxnABRatio, rxnProductRatio: snap.rxnProductRatio, hotColdRatio: snap.hotColdRatio, nucDh: snap.nucDh, nucBal: snap.nucBal, nucRad: snap.nucRad, nucHURatio: snap.nucHURatio, nucNPct: snap.nucNPct, coup: snap.coup, rest: snap.rest, eam: snap.eam, nucEam: snap.nucEam,
            walls: snap.walls.map(w=>({...w})), wallSolidity: snap.wallSolidity, wallThermalPerm: snap.wallThermalPerm, wallLeftTemp: snap.wallLeftTemp, wallRightTemp: snap.wallRightTemp, wallLeftNormPct: snap.wallLeftNormPct, wallLeftRevPct: snap.wallLeftRevPct,
            thermRev: snap.thermRev, thermRevRate: snap.thermRevRate, thermClamp: snap.thermClamp,
            spatialRev: snap.spatialRev, spatialRevRate: snap.spatialRevRate,
            spatialRevMode: snap.spatialRevMode, spatialHeatMode: snap.spatialHeatMode,
            revMode: snap.revMode, pCntNorm: snap.pCntNorm, pCntRev: snap.pCntRev,
            lastP: snap.lastP,
          });
          // Parçacıkları snapshot ayarlarıyla yeniden üret
          const pr = makePreset(snap.lastP, simW, h, snap.pCntNorm, snap.pCntRev);
          s.ps = pr.ps;
          s.frame=0; s.sH=[]; s.sN=[]; s.sR=[]; s.eH=[]; s.kH=[]; s.rxnT=0;
          s.revF=null; s.revI=0; s.run=false; s.spdAcc=0; s.timeReversed=false;
          { const bothOn=s.rxn&&s.nucRxn; if(s.rxn) seedReactants(s.ps, s.rxnABRatio, s.rxnProductRatio, bothOn?0.5:1); if(s.nucRxn) seedNuclear(s.ps, s.nucHURatio, s.nucNPct); } applyHotColdRatio(s.ps, s.hotColdRatio); if(s.walls.length>0){ applyWallPartition(s.ps, s.walls, s.wallLeftNormPct, s.wallLeftRevPct, simW, Math.round(simW*0.65)); applyWallTemps(s.ps, s.walls, s.wallLeftTemp, s.wallRightTemp); }
          for(const p of s.ps) delete p._wallSide;
          // Mod'u snapshot'tan yeniden uygula (sektör dönüşümü)
          if(snap.mode!==pr.mode) setMode(snap.mode);
          else if(s.mode==="reverse"&&s.revMode==="playback") genReverse(s.ps,simW,h);
          bump();
        }}
          style={{flex:.5,padding:"10px 0",borderRadius:6,border:"none",background:"#2a1010",color:"#c66",fontFamily:"inherit",fontWeight:600,fontSize:11,cursor:"pointer"}}
          title="Senaryo+mod varsayılanına dön">⏪</button>
      </div>

      <div style={{display:"flex",gap:3,padding:"0 8px 4px"}}>
        {(["normal","reverse","mixed_physical","mixed_cinematic"]).map(m=>(
          <button key={m} onClick={()=>setMode(m)}
            style={{flex:1,padding:"6px 2px",borderRadius:4,border:"none",background:s.mode===m?"#2a4080":"#14141e",
              color:s.mode===m?"#8ac":"#445",fontSize:9,fontWeight:600,fontFamily:"inherit",cursor:"pointer"}}>
            {modeLabels[m]}</button>
        ))}
      </div>

      {s.mode==="reverse"&&(
        <div style={{display:"flex",gap:4,padding:"0 8px 4px",alignItems:"center",flexWrap:"wrap"}}>
          <button onClick={()=>{s.revMode=s.revMode==="playback"?"dynamic":"playback";if(s.revMode==="playback")genReverse(s.ps,simW,simH);bump();}}
            style={{padding:"5px 10px",borderRadius:4,border:"1px solid #2a2a4a",background:s.revMode==="playback"?"#1a2050":"#201030",color:"#88a",fontSize:9,fontFamily:"inherit",cursor:"pointer"}}>
            {s.revMode==="playback"?"📼 Playback (25s)":"⚡ Dinamik (süresiz)"}
          </button>
          {s.revMode==="playback"&&(
            <>
              <button onClick={()=>{s.revLoop=!s.revLoop;bump();}}
                style={{padding:"5px 8px",borderRadius:4,border:"1px solid #2a2a4a",background:s.revLoop?"#1a3020":"#1a1020",color:s.revLoop?"#8a8":"#556",fontSize:9,fontFamily:"inherit",cursor:"pointer"}}>
                {s.revLoop?"🔁 Döngü":"➡ Tek"}
              </button>
              <button onClick={()=>{s.revI=0;if(s.revF)s.ps=s.revF[0].map(p=>({...p}));bump();}}
                style={{padding:"5px 8px",borderRadius:4,border:"1px solid #2a2a4a",background:"#201a10",color:"#a86",fontSize:9,fontFamily:"inherit",cursor:"pointer"}}>
                ⏮
              </button>
            </>
          )}
          {s.revMode==="dynamic"&&<span style={{fontSize:8,color:"#554"}}>Süresiz · FP hata birikebilir</span>}
        </div>
      )}

      {s.mode==="mixed_cinematic"&&(
        <div style={{margin:"0 8px 4px",fontSize:8,color:"#f80",background:"#f801",padding:"3px 6px",borderRadius:3}}>⚠ Sinematik: kavramsal gösterim</div>
      )}

      <div style={{display:"flex",borderBottom:"1px solid #1a1a2a"}}>
        {[tabBtn("ctrl","Kontrol"),tabBtn("preset","Senaryo"),tabBtn("stat","İstatistik"),tabBtn("info","Bilgi")]}
      </div>

      <div style={{padding:"8px",minHeight:160,paddingBottom:40}}>
        {tab==="ctrl"&&(<div>
          {/* Hız: 3 bölgeli slider — 0-1× | 1-10× | 10-100× eşit genişlikte */}
          <div style={{marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:10,color:"#778",marginBottom:2}}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>
                <HoldBtn style={{width:26,height:22,border:"none",borderRadius:3,background:"#1a1a2a",color:"#8899bb",fontSize:14,fontWeight:700,cursor:"pointer",padding:0,lineHeight:"22px",textAlign:"center",touchAction:"manipulation",userSelect:"none"}} action={()=>{const r=Math.max(0,s.spdRaw-1);s.spdRaw=r;if(r===0)s.spd=0;else if(r<=333)s.spd=0.01+(r-1)/332*0.99;else if(r<=666)s.spd=1+(r-333)/333*9;else s.spd=10+(r-666)/334*90;bump();}}>−</HoldBtn>
                <span>Hız</span>
                <HoldBtn style={{width:26,height:22,border:"none",borderRadius:3,background:"#1a1a2a",color:"#8899bb",fontSize:14,fontWeight:700,cursor:"pointer",padding:0,lineHeight:"22px",textAlign:"center",touchAction:"manipulation",userSelect:"none"}} action={()=>{const r=Math.min(1000,s.spdRaw+1);s.spdRaw=r;if(r===0)s.spd=0;else if(r<=333)s.spd=0.01+(r-1)/332*0.99;else if(r<=666)s.spd=1+(r-333)/333*9;else s.spd=10+(r-666)/334*90;bump();}}>+</HoldBtn>
              </span>
              <span style={{color:"#aab"}}>{
                s.spdRaw===0?"⏹ Durdur":
                (()=>{
                  let v;
                  if(s.spdRaw<=333) v=0.01+(s.spdRaw-1)/332*0.99;
                  else if(s.spdRaw<=666) v=1+(s.spdRaw-333)/333*9;
                  else v=10+(s.spdRaw-666)/334*90;
                  return s.spdRaw<=0?"⏹ Durdur": v<1?v.toFixed(2)+"×":v<10?v.toFixed(1)+"×":Math.round(v)+"×";
                })()
              }</span>
            </div>
            <input type="range" min={0} max={1000} step={1} value={s.spdRaw}
              onChange={e=>{
                const raw=parseInt(e.target.value);
                s.spdRaw=raw;
                if(raw===0){s.spd=0;}
                else if(raw<=333){s.spd=0.01+(raw-1)/332*0.99;}
                else if(raw<=666){s.spd=1+(raw-333)/333*9;}
                else{s.spd=10+(raw-666)/334*90;}
                bump();
              }}
              style={{width:"100%",height:6,accentColor:"#3070d0",cursor:"pointer"}}/>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:7,color:"#334",marginTop:1}}>
              <span>⏹</span><span style={{color:"#5080c0"}}>▼1×</span><span style={{color:"#5080c0"}}>▼10×</span><span>100×</span>
            </div>
          </div>
          <Sl label="Normal ●" value={s.pCntNorm} min={0} max={1000} step={1} fmt={v=>v.toFixed(0)+" parçacık"} onChange={v=>{s.pCntNorm=v;bump();}}/>
          <Sl label="Ters ◆" value={s.pCntRev} min={0} max={1000} step={1} fmt={v=>v.toFixed(0)+" parçacık"} onChange={v=>{s.pCntRev=v;bump();}}/>
          <div style={{fontSize:8,color:"#556",marginBottom:4}}>Toplam: {s.pCntNorm+s.pCntRev} parçacık (değişiklik sıfırlamada uygulanır)</div>
          <Sl label="Sıcak/Soğuk oranı" value={s.hotColdRatio} min={0} max={1} step={.01} fmt={v=>{
            const hot=Math.round(v*100), cold=100-hot;
            if(v<=0) return "100% soğuk";
            if(v>=1) return "100% sıcak";
            return cold+"% soğuk / "+hot+"% sıcak";
          }} onChange={v=>{s.hotColdRatio=v;bump();}}/>
          <div style={{fontSize:7,color:"#554",marginTop:-4,marginBottom:4}}>Yenileme (🔄) tuşuna basınca uygulanır</div>
          <Sl label="Elastiklik" value={s.rest} min={0} max={1} step={.01} fmt={v=>v.toFixed(2)} onChange={v=>{s.rest=v;bump();}}/>
          <Sl label="Kuplaj κ" value={s.coup} min={0} max={1} step={.01} fmt={v=>v.toFixed(2)} onChange={v=>{s.coup=v;bump();}}/>
          {s.rxn&&<Sl label="Kimyasal Ea çarpanı" value={s.eam} min={0} max={5} step={.01} fmt={v=>v.toFixed(2)} onChange={v=>{s.eam=v;bump();}}/>}
          {s.nucRxn&&<Sl label="Nükleer Ea çarpanı" value={s.nucEam} min={0} max={5} step={.01} fmt={v=>v.toFixed(2)} onChange={v=>{s.nucEam=v;bump();}}/>}
          <div style={{display:"flex",flexWrap:"wrap",gap:8,marginTop:8}}>
            <Tg label="Kimyasal Rk." v={s.rxn} set={v=>{s.rxn=v;if(v)seedReactants(s.ps,s.rxnABRatio,s.rxnProductRatio,s.nucRxn?0.5:1);bump();}}/>
            <Tg label="Nükleer Rk." v={s.nucRxn} set={v=>{s.nucRxn=v;if(v)seedNuclear(s.ps,s.nucHURatio,s.nucNPct);bump();}}/>
            <Tg label="Termal Ters ⚡" v={s.thermRev} set={v=>{s.thermRev=v;bump();}}/>
            <Tg label="Uzamsal Ters 🌀" v={s.spatialRev} set={v=>{s.spatialRev=v;bump();}}/>
            <Tg label="Hız vektör" v={s.showVel} set={v=>{s.showVel=v;bump();}}/>
            <Tg label="Sıcaklık bg" v={s.showTBg} set={v=>{s.showTBg=v;bump();}}/>
            <Tg label="Entropi map" v={s.showEMap} set={v=>{s.showEMap=v;bump();}}/>
            <Tg label="Bölme duvarı" v={s.walls.length>0} set={v=>{s.walls=v?[{x1:simW/2,y1:0,x2:simW/2,y2:simH}]:[];for(const p of s.ps)delete p._wallSide;bump();}}/>
          </div>
          {s.rxn&&(
            <div style={{marginTop:6}}>
              <Sl label="A/B başlangıç oranı" value={s.rxnABRatio} min={0} max={1} step={.01} fmt={v=>{
                const pB=Math.round(v*100), pA=100-pB;
                return pA+"%A / "+pB+"%B";
              }} onChange={v=>{s.rxnABRatio=v;bump();}}/>
              <Sl label="Reaktan/Ürün oranı" value={s.rxnProductRatio} min={0} max={1} step={.01} fmt={v=>{
                const pProd=Math.round(v*100), pReact=100-pProd;
                if(v<=0) return "100% A+B (reaktan)";
                if(v>=1) return "100% AB (ürün)";
                return pReact+"% A+B / "+pProd+"% AB";
              }} onChange={v=>{s.rxnProductRatio=v;bump();}}/>
              <div style={{fontSize:7,color:"#554",marginTop:-4,marginBottom:4}}>Yenileme (🔄) tuşuna basınca uygulanır</div>
              <Sl label="Kimyasal ΔH kayması" value={s.rxnDh} min={-5} max={5} step={.01} fmt={v=>{
                if(v<-0.05) return v.toFixed(1)+" (ekzotermik ↑)";
                if(v>0.05) return "+"+v.toFixed(1)+" (endotermik ↑)";
                return "0.0 (nötr)";
              }} onChange={v=>{s.rxnDh=v;bump();}}/>
              <Sl label="Kimyasal ileri/geri" value={s.rxnBal} min={0.1} max={5} step={.01} fmt={v=>{
                if(v>1.05) return v.toFixed(1)+"× (ileri baskın)";
                if(v<0.95) return v.toFixed(1)+"× (geri baskın)";
                return "1.0× (dengeli)";
              }} onChange={v=>{s.rxnBal=v;bump();}}/>
              <Sl label="Kimyasal yarıçap" value={s.rxnRad} min={4} max={40} step={1} fmt={v=>v.toFixed(0)+"px"} onChange={v=>{s.rxnRad=v;bump();}}/>
            </div>
          )}
          {s.nucRxn&&(
            <div style={{marginTop:6}}>
              <Sl label="H / U dağılımı" value={s.nucHURatio} min={0} max={1} step={.01} fmt={v=>{
                const pU=Math.round(v*100), pH=100-pU;
                if(v<=0) return "100% H (füzyon)";
                if(v>=1) return "100% U (fisyon)";
                return pH+"% H / "+pU+"% U";
              }} onChange={v=>{s.nucHURatio=v;bump();}}/>
              <Sl label="Nötron oranı" value={s.nucNPct} min={0} max={0.3} step={.01} fmt={v=>Math.round(v*100)+"%"} onChange={v=>{s.nucNPct=v;bump();}}/>
              <div style={{fontSize:7,color:"#554",marginTop:-4,marginBottom:4}}>Yenileme (🔄) tuşuna basınca uygulanır</div>
              <Sl label="Nükleer ΔH kayması" value={s.nucDh} min={-10} max={10} step={.01} fmt={v=>{
                if(v<-0.25) return v.toFixed(1)+" (daha ekzotermik)";
                if(v>0.25) return "+"+v.toFixed(1)+" (daha endotermik)";
                return "0.0 (nötr)";
              }} onChange={v=>{s.nucDh=v;bump();}}/>
              <Sl label="Nükleer ileri/geri" value={s.nucBal} min={0.1} max={5} step={.01} fmt={v=>{
                if(v>1.05) return v.toFixed(1)+"× (fisyon/füzyon baskın)";
                if(v<0.95) return v.toFixed(1)+"× (geri birleşme baskın)";
                return "1.0× (dengeli)";
              }} onChange={v=>{s.nucBal=v;bump();}}/>
              <Sl label="Nükleer yarıçap" value={s.nucRad} min={4} max={40} step={1} fmt={v=>v.toFixed(0)+"px"} onChange={v=>{s.nucRad=v;bump();}}/>
            </div>
          )}
          {s.thermRev&&(
            <div style={{marginTop:6}}>
              <Sl label="Anti-Fourier şiddeti" value={s.thermRevRate} min={0} max={1.0} step={.01} fmt={v=>v.toFixed(2)} onChange={v=>{s.thermRevRate=v;bump();}}/>
              <Sl label="Enerji aktarım oranı" value={s.thermClamp} min={0} max={1.1} step={.01} fmt={v=>{
                if(v<=0) return "0.00 (tam koruma)";
                if(v>1.0) return "∞ (sınırsız)";
                if(v>=1) return "1.00 (tam transfer)";
                return v.toFixed(2);
              }} onChange={v=>{s.thermClamp=v;bump();}}/>
              <div style={{fontSize:8,color:"#665",marginTop:2}}>
                {s.thermClamp<=0
                  ?"Tam koruma: enerji transferi engellenir"
                  :s.thermClamp>1.0
                    ?"Sınırsız: clamp devre dışı, tam agresif cascade"
                  :s.thermClamp>=1
                    ?"Tam transfer: soğuk cismin tüm enerjisi çalınabilir"
                    :"Soğuk cismin enerjisinin en fazla %"+(s.thermClamp*100).toFixed(0)+"'i çalınır"}
              </div>
            </div>
          )}
          {s.spatialRev&&(
            <div style={{marginTop:6}}>
              <div style={{display:"flex",gap:4,marginBottom:4}}>
                <button onClick={()=>{s.spatialRevMode="cluster";bump();}}
                  style={{flex:1,padding:"5px 4px",borderRadius:4,border:"none",fontSize:9,fontWeight:600,fontFamily:"inherit",cursor:"pointer",
                    background:s.spatialRevMode==="cluster"?"#1a4030":"#14141e",color:s.spatialRevMode==="cluster"?"#6d6":"#445"}}>
                  🧲 Toplanma
                </button>
                <button onClick={()=>{s.spatialRevMode="disperse";bump();}}
                  style={{flex:1,padding:"5px 4px",borderRadius:4,border:"none",fontSize:9,fontWeight:600,fontFamily:"inherit",cursor:"pointer",
                    background:s.spatialRevMode==="disperse"?"#402020":"#14141e",color:s.spatialRevMode==="disperse"?"#d66":"#445"}}>
                  💥 Dağılma
                </button>
              </div>
              <Sl label="Anti-difüzyon şiddeti" value={s.spatialRevRate} min={0} max={1} step={.01} fmt={v=>v.toFixed(2)} onChange={v=>{s.spatialRevRate=v;bump();}}/>
              <div style={{fontSize:8,color:"#778",marginTop:6,marginBottom:3}}>Termal etki:</div>
              <div style={{display:"flex",gap:3}}>
                <button onClick={()=>{s.spatialHeatMode="heat";bump();}}
                  style={{flex:1,padding:"4px 2px",borderRadius:3,border:"none",fontSize:8,fontWeight:600,fontFamily:"inherit",cursor:"pointer",
                    background:s.spatialHeatMode==="heat"?"#4a2020":"#14141e",color:s.spatialHeatMode==="heat"?"#f88":"#445"}}>
                  🔥 Isınır
                </button>
                <button onClick={()=>{s.spatialHeatMode="none";bump();}}
                  style={{flex:1,padding:"4px 2px",borderRadius:3,border:"none",fontSize:8,fontWeight:600,fontFamily:"inherit",cursor:"pointer",
                    background:s.spatialHeatMode==="none"?"#2a2a3a":"#14141e",color:s.spatialHeatMode==="none"?"#aab":"#445"}}>
                  ⚪ Etki yok
                </button>
                <button onClick={()=>{s.spatialHeatMode="cool";bump();}}
                  style={{flex:1,padding:"4px 2px",borderRadius:3,border:"none",fontSize:8,fontWeight:600,fontFamily:"inherit",cursor:"pointer",
                    background:s.spatialHeatMode==="cool"?"#1a2a4a":"#14141e",color:s.spatialHeatMode==="cool"?"#88d":"#445"}}>
                  ❄ Soğur
                </button>
              </div>
              <div style={{fontSize:8,color:"#665",marginTop:3}}>
                {s.spatialRevMode==="cluster"
                  ? (s.spatialHeatMode==="heat"?"Toplanırken ısınır":s.spatialHeatMode==="cool"?"Toplanırken soğur":"Toplanırken termal etki yok")
                  : (s.spatialHeatMode==="heat"?"Dağılırken ısınır":s.spatialHeatMode==="cool"?"Dağılırken soğur":"Dağılırken termal etki yok")
                }
              </div>
            </div>
          )}
          {s.walls.length>0&&(
            <div style={{marginTop:6}}>
              <Sl label="Duvar katılığı (madde)" value={s.wallSolidity} min={0} max={1} step={.001} fmt={v=>{
                if(v>=1) return "1.000 (tam katı)";
                if(v<=0) return "0.000 (saydam)";
                return v.toFixed(3);
              }} onChange={v=>{s.wallSolidity=v;bump();}}/>
              <div style={{fontSize:8,color:"#665",marginTop:2}}>
                {s.wallSolidity>=1?"Hiçbir parçacık geçemez":
                 s.wallSolidity<=0?"Tüm parçacıklar serbestçe geçer":
                 `Her çarpışmada %${((1-s.wallSolidity)*100).toFixed(1)} geçiş olasılığı`}
              </div>
              <div style={{marginTop:6}}/>
              <Sl label="Duvar ısı geçirgenliği" value={s.wallThermalPerm} min={0} max={1} step={.01} fmt={v=>{
                if(v>=1) return "1.00 (tam iletken)";
                if(v<=0) return "0.00 (tam yalıtkan)";
                return v.toFixed(2);
              }} onChange={v=>{s.wallThermalPerm=v;bump();}}/>
              <div style={{fontSize:8,color:"#665",marginTop:2}}>
                {s.wallThermalPerm<=0?"Isı duvardan geçemez (yalıtım)":
                 s.wallThermalPerm>=1?"Isı duvardan serbestçe akar":
                 `Isının %${(s.wallThermalPerm*100).toFixed(0)}'i duvardan geçer`}
              </div>
              <div style={{marginTop:6}}/>
              <Sl label="Sol alan sıcaklığı" value={s.wallLeftTemp} min={0} max={1} step={.01} fmt={v=>{
                if(v<=0) return "soğuk";
                if(v>=1) return "sıcak";
                return Math.round(v*100)+"% sıcak";
              }} onChange={v=>{s.wallLeftTemp=v;bump();}}/>
              <Sl label="Sağ alan sıcaklığı" value={s.wallRightTemp} min={0} max={1} step={.01} fmt={v=>{
                if(v<=0) return "soğuk";
                if(v>=1) return "sıcak";
                return Math.round(v*100)+"% sıcak";
              }} onChange={v=>{s.wallRightTemp=v;bump();}}/>
              <div style={{fontSize:7,color:"#554",marginTop:-4,marginBottom:4}}>Yenileme (🔄) tuşuna basınca uygulanır</div>
              <div style={{marginTop:6}}/>
              <Sl label="Sol Normal %" value={s.wallLeftNormPct} min={0} max={1} step={.01} fmt={v=>{
                const l=Math.round(v*100), r=100-l;
                return "Sol "+l+"% / Sağ "+r+"%";
              }} onChange={v=>{s.wallLeftNormPct=v;bump();}}/>
              <Sl label="Sol Ters %" value={s.wallLeftRevPct} min={0} max={1} step={.01} fmt={v=>{
                const l=Math.round(v*100), r=100-l;
                return "Sol "+l+"% / Sağ "+r+"%";
              }} onChange={v=>{s.wallLeftRevPct=v;bump();}}/>
              <div style={{fontSize:7,color:"#554",marginTop:-4,marginBottom:4}}>Parçacık dağılımı — 🔄 ile uygulanır</div>
            </div>
          )}
        </div>)}

        {tab==="preset"&&(<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
          {[["default_mode","⚪ Varsayılan","Rastgele dağılımlı, sıfır ayar"],
            ["hot_cold","🌡 Sıcak-Soğuk","Sol sıcak, sağ soğuk"],
            ["reverse","⏪ Reverse","Kümelenme→dağılım tersi"],
            ["therm_rev","🔥❄ Termal Ters","Anti-Fourier kutuplaşma"],
            ["therm_mixed","⚡ Termal Karma","Normal vs Anti-Fourier"],
            ["full_rev","🌀 Tam Ters","Uzamsal+termal tam reverse"],
            ["full_mixed","🔬 Tam Karma","Normal vs tam ters yan yana"],
            ["rxn_ab","⚗ A+B Reaksiyon","Sentez deneyi"],
            ["mixed_w","🔗 Karma Zayıf","Düşük κ karma"],
            ["mixed_d","💥 Karma Bozulma","Yüksek κ decoherence"],
            ["partition","🧱 Bölme Kaldır","Karışma senaryosu"],
            ["endo_exo","🔥 Endo vs Ekzo","Reaksiyon karşılaştırma"],
            ["fusion","☀ Füzyon","Sıcak H plazmasi → He birleşme"],
            ["fission","☢ Fisyon","U + nötron → zincir reaksiyonu"]
          ].map(([k,label,desc])=>(
            <button key={k} onClick={()=>{s.lastP=k;load(k);}}
              style={{padding:"10px 8px",borderRadius:6,border:"1px solid #1e1e2e",background:"#10101a",color:"#8899bb",textAlign:"left",cursor:"pointer",fontFamily:"inherit"}}>
              <div style={{fontSize:11,fontWeight:600}}>{label}</div>
              <div style={{fontSize:8,color:"#556",marginTop:2}}>{desc}</div>
            </button>
          ))}
        </div>)}

        {tab==="stat"&&(<div style={{fontSize:10}}>
          <Row l="Kare" v={s.frame}/><Row l="Parçacık" v={nTot}/>
          <Row l="  Normal" v={nN} c="#66b4ff"/><Row l="  Reverse" v={nR} c="#b466ff"/>
          {nN>0&&Object.keys(normTypes).length>0&&(
            <div style={{marginLeft:12}}>
              <div style={{color:"#66b4ff",fontSize:9,marginTop:2}}>Normal alt gruplar:</div>
              {Object.entries(normTypes).map(([t,c])=><Row key={"n"+t} l={"  "+(typeNames[t]||"?")} v={c} c={typeColors[t]||"#888"}/>)}
            </div>
          )}
          {nR>0&&Object.keys(revTypes).length>0&&(
            <div style={{marginLeft:12}}>
              <div style={{color:"#b466ff",fontSize:9,marginTop:2}}>Reverse alt gruplar:</div>
              {Object.entries(revTypes).map(([t,c])=><Row key={"r"+t} l={"  "+(typeNames[t]||"?")} v={c} c={typeColors[t]||"#888"}/>)}
            </div>
          )}
          <div style={{height:6}}/><Row l="Toplam E" v={tE.toFixed(1)}/><Row l="  Kinetik" v={tK.toFixed(1)}/><Row l="Ort. T" v={avgT.toFixed(2)}/>
          <div style={{height:6}}/><Row l="Entropi (≈)" v={calcEntropy(s.ps,simW,simH).toFixed(2)}/>
          {nR>0&&<Row l="Decoherence" v={dec.toFixed(2)} c={dec>.7?"#f44":dec>.4?"#f80":"#8a8"}/>}
          {s.mode==="reverse"&&s.revMode==="playback"&&s.revF&&(
            <Row l="Playback" v={`${Math.round(s.revI/(s.revF.length-1)*100)}%`} c="#88a"/>
          )}
          <div style={{height:6}}/><Row l="Reaksiyonlar" v={s.rxnT}/>
        </div>)}

        {tab==="info"&&(<div style={{fontSize:10,color:"#778",lineHeight:1.6}}>
          <p style={{color:"#f80",fontWeight:600,margin:"0 0 6px"}}>⚠ Eğitimsel toy model.</p>
          <p style={{margin:"0 0 6px"}}>"Ters entropili sektör" gerçek fizikte doğrulanmış bir kavram değildir. Termodinamik okun yönünü kavramsal olarak keşfetmek için tasarlanmış iç tutarlı bir kurgudur.</p>
          <p style={{margin:"0 0 6px"}}><b style={{color:"#aab"}}>Playback:</b> İleriye simüle et → kaydet → ters oynat. Hamiltonian zaman tersleme. ~25 sn döngü. Fiziksel olarak tutarlı.</p>
          <p style={{margin:"0 0 6px"}}><b style={{color:"#aab"}}>Dinamik:</b> Her adımda v→-v, ileri adım, v→-v. Süresiz çalışır ama FP hata birikir. Deneysel.</p>
          <p style={{margin:"0 0 6px"}}><b style={{color:"#aab"}}>Termal Ters (Anti-Fourier):</b> Normal fizikte ısı sıcaktan soğuğa akar (Fourier). Bu modda ters: sıcak reverse parçacıklar enerji toplar, soğuklar kaybeder → sıcaklık homojenleşmek yerine kutuplaşır. Maxwell'in cini benzeri bir kavramsal gösterim.</p>
          <p style={{margin:"0 0 6px"}}><b style={{color:"#aab"}}>Uzamsal Ters (Anti-Difüzyon):</b> İki mod: 🧲 Toplanma → dağınık parçacıklar kütle merkezine çekilir (ters entropi). 💥 Dağılma → parçacıklar COM'dan uzaklaştırılır (hızlandırılmış difüzyon). Kontrol sekmesinden tek tuşla geçiş.</p>
          <p style={{margin:"0 0 6px"}}><b style={{color:"#aab"}}>Entropi:</b> Shannon bilgi entropisi. Termodinamik mutlak entropi değil.</p>
          <p style={{margin:"0 0 6px"}}><b style={{color:"#aab"}}>Karma:</b> κ artınca reverse sektör bozulur (decoherence). Sinematik mod kavramsal gösterimdir.</p>
        </div>)}
      </div>
    </div>
  );
}

// Basılı tutma tekrarlama butonu (stale closure koruması)
function HoldBtn({action,children,style:st}) {
  const actionRef = useRef(action);
  actionRef.current = action; // Her render'da güncelle
  const timers = useRef({t1:null,t2:null});
  const start = () => {
    actionRef.current();
    timers.current.t1 = setTimeout(() => {
      timers.current.t2 = setInterval(() => actionRef.current(), 70);
    }, 400);
  };
  const stop = () => {
    clearTimeout(timers.current.t1);
    clearInterval(timers.current.t2);
  };
  return <button style={st} onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}>{children}</button>;
}

function Sl({label,value,min,max,step,fmt,onChange}){
  const s=step||0.01;
  const dec=()=>{const v=Math.max(min,Math.round((value-s)*1e6)/1e6);onChange(v);};
  const inc=()=>{const v=Math.min(max,Math.round((value+s)*1e6)/1e6);onChange(v);};
  const btnSt={width:26,height:22,border:"none",borderRadius:3,background:"#1a1a2a",color:"#8899bb",fontSize:14,fontWeight:700,cursor:"pointer",padding:0,lineHeight:"22px",textAlign:"center",touchAction:"manipulation",userSelect:"none",WebkitUserSelect:"none"};
  return(<div style={{marginBottom:8}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:10,color:"#778",marginBottom:2}}>
      <span style={{display:"flex",alignItems:"center",gap:4}}><HoldBtn style={btnSt} action={dec}>−</HoldBtn><span>{label}</span><HoldBtn style={btnSt} action={inc}>+</HoldBtn></span>
      <span style={{color:"#aab"}}>{fmt(value)}</span>
    </div>
    <input type="range" min={min} max={max} step={step} value={value} onChange={e=>onChange(parseFloat(e.target.value))} style={{width:"100%",height:6,accentColor:"#3070d0",cursor:"pointer"}}/>
  </div>);
}
function Tg({label,v,set}){
  return(<div onClick={()=>set(!v)} style={{display:"flex",alignItems:"center",gap:5,cursor:"pointer"}}>
    <div style={{width:24,height:13,borderRadius:7,background:v?"#2a7a4a":"#222",position:"relative",transition:".2s"}}>
      <div style={{width:9,height:9,borderRadius:5,background:"#dde",position:"absolute",top:2,left:v?13:2,transition:".2s"}}/>
    </div><span style={{fontSize:9,color:v?"#aab":"#445"}}>{label}</span>
  </div>);
}
function Row({l,v,c}){
  return(<div style={{display:"flex",justifyContent:"space-between",color:c||"#889",lineHeight:1.7}}><span>{l}</span><span style={{color:c||"#aab"}}>{v}</span></div>);
}
