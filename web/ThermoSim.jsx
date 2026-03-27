import { useState, useEffect, useRef, useCallback } from "react";

/* ═══════════════════════════════════════════════════════════════
   TERMODİNAMİK SİMÜLASYON — TOY MODEL (Mobil)
   ═══════════════════════════════════════════════════════════════ */

const SPEED_CAP = 400, ENERGY_CAP = 1e4;
const TYPE_A = 0, TYPE_B = 1, TYPE_AB = 2, TYPE_FUEL = 3, TYPE_OX = 4, TYPE_PRODUCT = 5;
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
  return {x,y,vx,vy,ptype:pt,sector:sec,mass,radius:r,energy:0,flash:0};
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
function wallThermalTransfer(ps, walls, dt, thermalPerm) {
  if (!walls || walls.length === 0 || thermalPerm < 0.001) return;

  for (const w of walls) {
    if (Math.abs(w.x1 - w.x2) < 2) {
      const wx = (w.x1 + w.x2) / 2;
      const miny = Math.min(w.y1, w.y2), maxy = Math.max(w.y1, w.y2);
      const proximity = 60; // Duvardan bu mesafedeki parçacıklar etkilenir

      // İki taraftaki parçacıkları topla
      const left = [], right = [];
      for (const p of ps) {
        if (p.y < miny - p.radius || p.y > maxy + p.radius) continue;
        const dist = Math.abs(p.x - wx);
        if (dist > proximity) continue;
        if (p.x < wx) left.push(p);
        else right.push(p);
      }

      if (left.length === 0 || right.length === 0) continue;

      // Ortalama KE hesapla
      let keL = 0, keR = 0;
      for (const p of left) keL += p.vx * p.vx + p.vy * p.vy;
      for (const p of right) keR += p.vx * p.vx + p.vy * p.vy;
      keL /= left.length;
      keR /= right.length;

      const diff = keL - keR;
      if (Math.abs(diff) < 0.01) continue;

      // Transfer miktarı: farkın thermalPerm * dt oranında
      const transfer = diff * thermalPerm * dt * 2;

      // Sol taraf sıcaksa: sol yavaşlar, sağ hızlanır (veya tersi)
      const scaleL = Math.sqrt(Math.max((keL - transfer / left.length) / Math.max(keL, 0.001), 0.1));
      const scaleR = Math.sqrt(Math.max((keR + transfer / right.length) / Math.max(keR, 0.001), 0.1));

      // Soft clamp
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
function physicsStep(ps, W, H, dt, mode, rest, coupling, walls, thermRev, thermRevRate, wallSolidity) {
  const isRev = mode==="reverse"||mode==="mixed_physical"||mode==="mixed_cinematic";
  if(isRev) for(const p of ps) if(p.sector===SECTOR_REVERSE){p.vx*=-1;p.vy*=-1;}

  for(const p of ps){p.x+=p.vx*dt;p.y+=p.vy*dt;}
  const d=.98;
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
        const e=rest;
        let tf=1;
        if(a.sector!==b.sector&&(mode==="mixed_physical"||mode==="mixed_cinematic"))
          tf=mode==="mixed_physical"?coupling:1;
        const imp=(1+e)*dvn/(1/a.mass+1/b.mass);
        a.vx-=(imp*nx)/a.mass;a.vy-=(imp*ny)/a.mass;
        b.vx+=(imp*nx)/b.mass;b.vy+=(imp*ny)/b.mass;
        if(e<1){const loss=.5*imp*dvn*(1-e*e)*tf;a.energy+=loss*b.mass/tm;b.energy+=loss*a.mass/tm;}
        if(thermRev && thermRevRate > 0.001 && a.sector===SECTOR_REVERSE && b.sector===SECTOR_REVERSE){
          antiCollisionFourier(a, b, thermRevRate);
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
  for(const p of ps){
    const spd=Math.sqrt(p.vx*p.vx+p.vy*p.vy);
    if(spd>SPEED_CAP){const sc=SPEED_CAP/spd;p.vx*=sc;p.vy*=sc;}
    if(isNaN(p.x)||isNaN(p.y)){p.x=W/2;p.y=H/2;p.vx=0;p.vy=0;}
    if(p.energy>ENERGY_CAP) p.energy=ENERGY_CAP;
    p.flash=Math.max(0,p.flash-dt);
  }
  // Duvar kontrolü #3: son güvenlik geçişi (v→-v sonrası hiçbir şey kaçmasın)
  enforceWalls(ps, walls, wallSolidity, d);
}

// ─── ANTİ-FOURİER TERMAL REVERSE (v7 — Gerçek Cascade) ────────
/*
 * Çarpışma bazlı + post-step cascade.
 * Sıcak reverse cisim soğuktan enerji ÇALAR → ısı tek cisme toplanır.
 * rate=1 → tam cascade.
 */
function antiCollisionFourier(a, b, rate) {
  if (rate < 0.001) return;
  if (a.sector !== SECTOR_REVERSE || b.sector !== SECTOR_REVERSE) return;
  const keA = a.vx * a.vx + a.vy * a.vy;
  const keB = b.vx * b.vx + b.vy * b.vy;
  const diff = keA - keB;
  if (Math.abs(diff) < 0.001) return;
  const transfer = diff * rate * 0.5;
  const factorA = Math.sqrt(Math.max((keA + transfer) / Math.max(keA, 0.001), 0.01));
  const factorB = Math.sqrt(Math.max((keB - transfer) / Math.max(keB, 0.001), 0.01));
  a.vx *= Math.min(factorA, 5.0); a.vy *= Math.min(factorA, 5.0);
  b.vx *= Math.max(factorB, 0.05); b.vy *= Math.max(factorB, 0.05);
}

function antiFourierStep(ps, W, H, dt, rate) {
  if (rate < 0.001) return;
  const rev = [];
  for (let i = 0; i < ps.length; i++) { if (ps[i].sector === SECTOR_REVERSE) rev.push(i); }
  if (rev.length < 2) return;
  const radius = 40, radiusSq = radius * radius;
  for (let ii = 0; ii < rev.length; ii++) {
    const i = rev[ii], a = ps[i], keA = a.vx * a.vx + a.vy * a.vy;
    for (let jj = ii + 1; jj < rev.length; jj++) {
      const j = rev[jj], b = ps[j], dx = b.x - a.x, dy = b.y - a.y;
      if (dx * dx + dy * dy > radiusSq) continue;
      const keB = b.vx * b.vx + b.vy * b.vy, diff = keA - keB;
      if (Math.abs(diff) < 0.001) continue;
      const transfer = diff * rate * dt;
      const newKeA = keA + transfer, newKeB = keB - transfer;
      const factorA = Math.sqrt(Math.max(newKeA / Math.max(keA, 0.0001), 0.01));
      const factorB = Math.sqrt(Math.max(newKeB / Math.max(keB, 0.0001), 0.01));
      a.vx *= Math.min(factorA, 3.0); a.vy *= Math.min(factorA, 3.0);
      b.vx *= Math.max(factorB, 0.02); b.vy *= Math.max(factorB, 0.02);
    }
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
function antiDiffusionStep(ps, W, H, dt, rate, mode, walls, wallSolidity, heatMode) {
  if (rate < 0.001) return;

  const sign = mode === "disperse" ? -1 : 1;
  const sol = (typeof wallSolidity === "number") ? wallSolidity : 1;
  // heatMode: "heat" (ısınır), "none" (termal etki yok), "cool" (soğur)
  const thermal = heatMode || "none";

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
const RXNS=[
  {name:"A+B→AB",r:[TYPE_A,TYPE_B],p:[TYPE_AB],ea:3,dh:-2,kf:.8,kb:.3,bin:true},
  {name:"Fuel+Ox→Ür",r:[TYPE_FUEL,TYPE_OX],p:[TYPE_PRODUCT],ea:4,dh:-5,kf:1,kb:.05,bin:true},
  {name:"AB→A+B",r:[TYPE_AB],p:[TYPE_A,TYPE_B],ea:5,dh:2,kf:.4,kb:.6,bin:false},
];
function rxnStep(ps,dt,mode,rr,on,eam,isr){
  if(!on) return 0;
  for(let i=0;i<ps.length;i++) for(let j=i+1;j<ps.length;j++){
    const a=ps[i],b=ps[j],dx=b.x-a.x,dy=b.y-a.y;
    if(dx*dx+dy*dy>rr*rr) continue;
    if(a.sector!==b.sector&&!isr) continue;
    for(const rule of RXNS){
      if(!rule.bin) continue;
      const t=[a.ptype,b.ptype];
      if(!((t[0]===rule.r[0]&&t[1]===rule.r[1])||(t[0]===rule.r[1]&&t[1]===rule.r[0]))) continue;
      const temp=Math.max(.5*((a.vx*a.vx+a.vy*a.vy)+(b.vx*b.vx+b.vy*b.vy))*.5,.01);
      const isR=a.sector===SECTOR_REVERSE&&(mode==="reverse"||mode.startsWith("mixed"));
      const rate=isR?(rule.kb>.001?rule.kb*Math.exp(-(rule.ea-rule.dh)*eam/temp):0):rule.kf*Math.exp(-rule.ea*eam/temp);
      if(Math.random()>Math.min(rate*dt,.4)) continue;
      const mx=(a.x+b.x)/2,my=(a.y+b.y)/2,mvx=(a.vx+b.vx)/2,mvy=(a.vy+b.vy)/2,sec=a.sector;
      ps.splice(Math.max(i,j),1);ps.splice(Math.min(i,j),1);
      for(const pt of rule.p){
        let nvx=mvx+gaussRandom()*.5,nvy=mvy+gaussRandom()*.5;
        if(rule.dh<0){const bo=Math.sqrt(Math.abs(rule.dh));const l=Math.sqrt(nvx*nvx+nvy*nvy)||1;nvx+=(nvx/l)*bo*.5;nvy+=(nvy/l)*bo*.5;}
        const np=createP(mx+(Math.random()-0.5)*6,my+(Math.random()-0.5)*6,nvx,nvy,pt,sec);np.flash=.3;ps.push(np);
      }
      return 1;
    }
  }
  for(let i=0;i<ps.length;i++){
    const a=ps[i];
    for(const rule of RXNS){
      if(rule.bin||a.ptype!==rule.r[0]) continue;
      const temp=Math.max(.5*(a.vx*a.vx+a.vy*a.vy),.01);
      const isR=a.sector===SECTOR_REVERSE&&(mode==="reverse"||mode.startsWith("mixed"));
      const rate=isR?(rule.kb>.001?rule.kb*Math.exp(-(rule.ea-rule.dh)*eam/temp):0):rule.kf*Math.exp(-rule.ea*eam/temp);
      if(Math.random()>Math.min(rate*dt,.3)) continue;
      const ke=.5*a.mass*(a.vx*a.vx+a.vy*a.vy);
      if(rule.dh>0&&ke<rule.dh) continue;
      const sx=a.x,sy=a.y;let svx=a.vx,svy=a.vy;const sec=a.sector;
      if(rule.dh>0){const sl=Math.sqrt(Math.max((ke-rule.dh)/Math.max(ke,.001),.01));svx*=sl;svy*=sl;}
      ps.splice(i,1);
      for(let k=0;k<rule.p.length;k++){
        const ang=(2*Math.PI*k)/rule.p.length+gaussRandom()*.3;
        const np=createP(sx+Math.cos(ang)*5,sy+Math.sin(ang)*5,svx*.7+gaussRandom()*1.5,svy*.7+gaussRandom()*1.5,rule.p[k],sec);
        np.flash=.3;ps.push(np);
      }
      return 1;
    }
  }
  return 0;
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
// Eksik alan bırakılmaz — load fonksiyonu bunları doğrudan uygular.
const PRESET_DEFAULTS = {
  mode:"normal", rxn:false, coup:0, walls:[],
  thermRev:false, thermRevRate:0.5,
  spatialRev:false, spatialRevRate:0.2, spatialRevMode:"cluster", spatialHeatMode:"heat",
  revMode:"dynamic", wallSolidity:1.0, wallThermalPerm:0.0,
  pCntNorm:80, pCntRev:0, // Önerilen parçacık sayıları
};

function makePreset(name, W, H, nNorm, nRev){
  const ps=[];
  // Preset kendi önerdiği sayıları kullanır, kullanıcı sayıları yedek
  let cfg = {...PRESET_DEFAULTS};

  switch(name){
    case "hot_cold": {
      cfg.pCntNorm=100; cfg.pCntRev=0; cfg.mode="normal";
      const n=nNorm||cfg.pCntNorm;
      for(let i=0;i<Math.floor(n/2);i++){const[vx,vy]=randVel(8);ps.push(createP(Math.random()*(W/2-20)+10,Math.random()*(H-20)+10,vx,vy));}
      for(let i=0;i<n-Math.floor(n/2);i++){const[vx,vy]=randVel(1);ps.push(createP(W/2+10+Math.random()*(W/2-20),Math.random()*(H-20)+10,vx,vy));}
      break;
    }
    case "reverse": {
      cfg.pCntNorm=0; cfg.pCntRev=100; cfg.mode="reverse"; cfg.revMode="dynamic";
      cfg.spatialRev=true; cfg.spatialRevMode="cluster"; cfg.spatialHeatMode="heat";
      const n=nRev||cfg.pCntRev;
      for(let i=0;i<n;i++){const[vx,vy]=randVel(3);ps.push(createP(Math.random()*(W-20)+10,Math.random()*(H-20)+10,vx,vy,TYPE_A,SECTOR_REVERSE));}
      break;
    }
    case "rxn_ab": {
      cfg.pCntNorm=100; cfg.pCntRev=0; cfg.mode="normal"; cfg.rxn=true;
      const n=nNorm||cfg.pCntNorm;
      for(let i=0;i<Math.floor(n/2);i++){const[vx,vy]=randVel(5);ps.push(createP(Math.random()*(W-20)+10,Math.random()*(H-20)+10,vx,vy,TYPE_A));}
      for(let i=0;i<n-Math.floor(n/2);i++){const[vx,vy]=randVel(5);ps.push(createP(Math.random()*(W-20)+10,Math.random()*(H-20)+10,vx,vy,TYPE_B));}
      break;
    }
    case "mixed_w": {
      cfg.pCntNorm=60; cfg.pCntRev=60; cfg.mode="mixed_physical"; cfg.coup=0.1;
      const nn=nNorm||cfg.pCntNorm, nr=nRev||cfg.pCntRev;
      for(let i=0;i<nr;i++){const[vx,vy]=randVel(4);ps.push(createP(Math.random()*(W/2-20)+10,Math.random()*(H-20)+10,vx,vy,TYPE_A,SECTOR_REVERSE));}
      for(let i=0;i<nn;i++){const[vx,vy]=randVel(4);ps.push(createP(W/2+10+Math.random()*(W/2-20),Math.random()*(H-20)+10,vx,vy,TYPE_A,SECTOR_NORMAL));}
      break;
    }
    case "mixed_d": {
      cfg.pCntNorm=80; cfg.pCntRev=40; cfg.mode="mixed_physical"; cfg.coup=0.6;
      const nr=nRev||cfg.pCntRev, nn=nNorm||cfg.pCntNorm;
      for(let i=0;i<nr;i++){const a=(2*Math.PI*i)/nr,r=30+Math.random()*40;const[vx,vy]=randVel(2);ps.push(createP(W/2+r*Math.cos(a),H/2+r*Math.sin(a),vx,vy,TYPE_A,SECTOR_REVERSE));}
      for(let i=0;i<nn;i++){const[vx,vy]=randVel(6);ps.push(createP(Math.random()*(W-20)+10,Math.random()*(H-20)+10,vx,vy,TYPE_A,SECTOR_NORMAL));}
      break;
    }
    case "partition": {
      cfg.pCntNorm=100; cfg.pCntRev=0; cfg.mode="normal";
      cfg.walls=[{x1:W/2,y1:0,x2:W/2,y2:H}]; cfg.wallSolidity=1.0;
      const n=nNorm||cfg.pCntNorm;
      for(let i=0;i<n;i++){const hot=i<n/2;const[vx,vy]=randVel(hot?7:1.5);ps.push(createP(hot?Math.random()*(W/2-20)+10:W/2+10+Math.random()*(W/2-20),Math.random()*(H-20)+10,vx,vy,hot?TYPE_A:TYPE_B));}
      break;
    }
    case "endo_exo": {
      cfg.pCntNorm=100; cfg.pCntRev=0; cfg.mode="normal"; cfg.rxn=true;
      const n=nNorm||cfg.pCntNorm, q=Math.floor(n/4);
      for(let i=0;i<q;i++){const[vx,vy]=randVel(5);ps.push(createP(Math.random()*(W/2-20)+10,Math.random()*(H-20)+10,vx,vy,TYPE_FUEL));}
      for(let i=0;i<q;i++){const[vx,vy]=randVel(5);ps.push(createP(Math.random()*(W/2-20)+10,Math.random()*(H-20)+10,vx,vy,TYPE_OX));}
      for(let i=0;i<n-2*q;i++){const[vx,vy]=randVel(7);ps.push(createP(W/2+10+Math.random()*(W/2-20),Math.random()*(H-20)+10,vx,vy,TYPE_AB));}
      break;
    }
    case "therm_rev": {
      cfg.pCntNorm=0; cfg.pCntRev=100; cfg.mode="reverse"; cfg.revMode="dynamic";
      cfg.thermRev=true; cfg.thermRevRate=0.5;
      const n=nRev||cfg.pCntRev;
      for(let i=0;i<n;i++){const temp=4+(Math.random()-0.5)*2;const[vx,vy]=randVel(temp);ps.push(createP(Math.random()*(W-20)+10,Math.random()*(H-20)+10,vx,vy,TYPE_A,SECTOR_REVERSE));}
      break;
    }
    case "therm_mixed": {
      cfg.pCntNorm=60; cfg.pCntRev=60; cfg.mode="mixed_physical"; cfg.coup=0.05;
      cfg.thermRev=true; cfg.thermRevRate=0.5; cfg.revMode="dynamic";
      const nn=nNorm||cfg.pCntNorm, nr=nRev||cfg.pCntRev;
      for(let i=0;i<nn;i++){const temp=4+(Math.random()-0.5)*1;const[vx,vy]=randVel(temp);ps.push(createP(Math.random()*(W/2-30)+15,Math.random()*(H-20)+10,vx,vy,TYPE_A,SECTOR_NORMAL));}
      for(let i=0;i<nr;i++){const temp=4+(Math.random()-0.5)*1;const[vx,vy]=randVel(temp);ps.push(createP(W/2+15+Math.random()*(W/2-30),Math.random()*(H-20)+10,vx,vy,TYPE_A,SECTOR_REVERSE));}
      break;
    }
    case "full_rev": {
      cfg.pCntNorm=0; cfg.pCntRev=100; cfg.mode="reverse"; cfg.revMode="dynamic";
      cfg.thermRev=true; cfg.thermRevRate=0.5;
      cfg.spatialRev=true; cfg.spatialRevMode="cluster"; cfg.spatialHeatMode="heat";
      const n=nRev||cfg.pCntRev;
      for(let i=0;i<n;i++){const temp=4+(Math.random()-0.5)*1.5;const[vx,vy]=randVel(temp);ps.push(createP(Math.random()*(W-20)+10,Math.random()*(H-20)+10,vx,vy,TYPE_A,SECTOR_REVERSE));}
      break;
    }
    case "full_mixed": {
      cfg.pCntNorm=60; cfg.pCntRev=60; cfg.mode="mixed_physical"; cfg.coup=0.05;
      cfg.thermRev=true; cfg.thermRevRate=0.5; cfg.revMode="dynamic";
      cfg.spatialRev=true; cfg.spatialRevMode="cluster"; cfg.spatialHeatMode="heat";
      const nn=nNorm||cfg.pCntNorm, nr=nRev||cfg.pCntRev;
      for(let i=0;i<nn;i++){const hot=i<nn/2;const temp=hot?8:1.5;const[vx,vy]=randVel(temp);const cx=W*0.15,cy=H*0.5;ps.push(createP(Math.max(6,Math.min(W/2-10,cx+(Math.random()-0.5)*70)),Math.max(6,Math.min(H-6,cy+(Math.random()-0.5)*60)),vx,vy,TYPE_A,SECTOR_NORMAL));}
      for(let i=0;i<nr;i++){const temp=4+(Math.random()-0.5)*1;const[vx,vy]=randVel(temp);ps.push(createP(W/2+10+Math.random()*(W/2-20),Math.random()*(H-20)+10,vx,vy,TYPE_A,SECTOR_REVERSE));}
      break;
    }
    default: return makePreset("hot_cold",W,H,nNorm,nRev);
  }

  cfg.ps = ps;
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

// ─── REAKSİYON TOHUMU ─────────────────────────────────────────
function seedReactants(ps) {
  let countA = 0;
  for (const p of ps) { if (p.ptype === TYPE_A) countA++; }
  if (countA > ps.length * 0.7) {
    let toConvert = Math.floor(countA * 0.4);
    for (const p of ps) {
      if (toConvert <= 0) break;
      if (p.ptype === TYPE_A && Math.random() < 0.5) {
        p.ptype = TYPE_B;
        toConvert--;
      }
    }
  }
}

// ─── COMPONENT ─────────────────────────────────────────────────
export default function ThermoSim() {
  const canvasRef = useRef(null);
  const S = useRef({
    ps:[], frame:0, run:false, mode:"normal", rest:.95, coup:0,
    rxn:false, isrxn:false, eam:1, spd:1,
    walls:[], wallSolidity:1.0, wallThermalPerm:0.0, showVel:false, showTBg:true, showEMap:false,
    revF:null, revI:0, revLoop:true, revMode:"playback",
    thermRev:false, thermRevRate:0.5,
    spatialRev:false, spatialRevRate:0.2, spatialRevMode:"cluster", spatialHeatMode:"heat",
    sH:[], sN:[], sR:[], eH:[], kH:[],
    rxnT:0, pCntNorm:60, pCntRev:60, lastP:"hot_cold", spdAcc:0, spdRaw:500
  });
  const raf = useRef(null);
  const [, tick] = useState(0);
  const bump = () => tick(c => c + 1);
  const [tab, setTab] = useState("ctrl");
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

  const load = useCallback((name) => {
    const s = S.current;
    const h = Math.round(simW * 0.65);
    const pr = makePreset(name, simW, h, s.pCntNorm, s.pCntRev);

    // Parçacıklar
    s.ps = pr.ps;
    s.frame = 0;
    s.sH=[]; s.sN=[]; s.sR=[]; s.eH=[]; s.kH=[];
    s.rxnT = 0;
    s.revF = null; s.revI = 0;
    s.lastP = name; s.run = false;

    // TÜM kontrol state'lerini preset'ten uygula
    s.mode = pr.mode;
    s.rxn = pr.rxn;
    s.coup = pr.coup;
    s.walls = pr.walls;
    s.wallSolidity = pr.wallSolidity;
    s.wallThermalPerm = pr.wallThermalPerm;
    s.thermRev = pr.thermRev;
    s.thermRevRate = pr.thermRevRate;
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
    bump();
  }, [simW, genReverse]);

  useEffect(() => { load("hot_cold"); }, [load]);

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
            for (const p of s.ps) { p.vx *= -1; p.vy *= -1; }
            physicsStep(s.ps, W, H, 1/60, "normal", 1.0, 0, s.walls, s.thermRev, s.thermRevRate, s.wallSolidity);
            for (const p of s.ps) { p.vx *= -1; p.vy *= -1; }
            s.rxnT += rxnStep(s.ps, 1/60, "reverse", 12, s.rxn, s.eam, s.isrxn);
            if (s.thermRev) antiFourierStep(s.ps, W, H, 1/60, s.thermRevRate);
            if (s.spatialRev) antiDiffusionStep(s.ps, W, H, 1/60, s.spatialRevRate, s.spatialRevMode, s.walls, s.wallSolidity, s.spatialHeatMode);
            enforceWalls(s.ps, s.walls, s.wallSolidity, 0.98);
            wallThermalTransfer(s.ps, s.walls, 1/60, s.wallThermalPerm);

          } else {
            physicsStep(s.ps, W, H, 1/60, s.mode, s.rest, s.coup, s.walls, s.thermRev, s.thermRevRate, s.wallSolidity);
            s.rxnT += rxnStep(s.ps, 1/60, s.mode, 12, s.rxn, s.eam, s.isrxn);
            if (s.thermRev && (s.mode === "mixed_physical" || s.mode === "mixed_cinematic")) {
              antiFourierStep(s.ps, W, H, 1/60, s.thermRevRate);
            }
            if (s.spatialRev && (s.mode === "mixed_physical" || s.mode === "mixed_cinematic")) {
              antiDiffusionStep(s.ps, W, H, 1/60, s.spatialRevRate, s.spatialRevMode, s.walls, s.wallSolidity, s.spatialHeatMode);
            }
            enforceWalls(s.ps, s.walls, s.wallSolidity, 0.98);
            wallThermalTransfer(s.ps, s.walls, 1/60, s.wallThermalPerm);
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
        else{ctx.beginPath();ctx.arc(p.x,p.y,p.radius,0,Math.PI*2);ctx.fill();ctx.strokeStyle={[TYPE_A]:"#66b4ff",[TYPE_B]:"#ffa050",[TYPE_AB]:"#b466ff",[TYPE_FUEL]:"#ff5050",[TYPE_OX]:"#50cc50",[TYPE_PRODUCT]:"#cccc66"}[p.ptype]||"#aaa";ctx.lineWidth=1;ctx.stroke();}
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
    const old = s.mode;
    s.mode = m;

    // Parçacık sektörlerini moda göre dönüştür
    if (m === "normal") {
      // Tüm parçacıkları normal yap
      for (const p of s.ps) p.sector = SECTOR_NORMAL;
    } else if (m === "reverse") {
      // Tüm parçacıkları reverse yap
      for (const p of s.ps) p.sector = SECTOR_REVERSE;
    } else if (m === "mixed_physical" || m === "mixed_cinematic") {
      // Karma: eğer hepsi aynı sektördeyse yarı yarıya böl
      const allSame = s.ps.every(p => p.sector === s.ps[0]?.sector);
      if (allSame && s.ps.length > 1) {
        const half = Math.floor(s.ps.length / 2);
        for (let i = 0; i < s.ps.length; i++) {
          s.ps[i].sector = i < half ? SECTOR_NORMAL : SECTOR_REVERSE;
        }
      }
    }

    // Reverse playback hazırla
    if (m === "reverse" && s.revMode === "playback") {
      genReverse(s.ps, simW, simH);
    }
    bump();
  };

  const nTot=s.ps.length,nN=s.ps.filter(p=>p.sector===SECTOR_NORMAL).length,nR=nTot-nN;
  let tE=0,tK=0;for(const p of s.ps){const ke=.5*p.mass*(p.vx*p.vx+p.vy*p.vy);tK+=ke;tE+=ke+p.energy;}
  const avgT=nTot>0?tK/nTot:0;
  const dec=decoherence(s.ps,simW,simH);

  const tabBtn=(id,label)=>(
    <button key={id} onClick={()=>setTab(id)}
      style={{flex:1,padding:"7px 0",background:tab===id?"#1a2a4a":"transparent",color:tab===id?"#5090ff":"#556",
        border:"none",borderBottom:tab===id?"2px solid #3070d0":"2px solid transparent",
        fontSize:10,fontWeight:600,fontFamily:"inherit",cursor:"pointer"}}>{label}</button>
  );

  return(
    <div style={{background:"#08080e",minHeight:"100vh",color:"#ccd",fontFamily:"'SF Mono','Menlo',monospace",maxWidth:600,margin:"0 auto"}}>
      <div style={{display:"flex",alignItems:"center",padding:"6px 8px",borderBottom:"1px solid #1a1a2a",gap:6}}>
        <span style={{fontSize:13,fontWeight:700,color:"#5090ff",letterSpacing:1}}>THERMOSIM v19</span>
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
          else if(s.mode==="reverse"&&s.revMode==="dynamic"){for(const p of s.ps){p.vx*=-1;p.vy*=-1;}physicsStep(s.ps,simW,simH,1/60,"normal",1,0,s.walls,s.thermRev,s.thermRevRate,s.wallSolidity);for(const p of s.ps){p.vx*=-1;p.vy*=-1;}s.rxnT+=rxnStep(s.ps,1/60,"reverse",12,s.rxn,s.eam,s.isrxn);if(s.thermRev)antiFourierStep(s.ps,simW,simH,1/60,s.thermRevRate);if(s.spatialRev)antiDiffusionStep(s.ps,simW,simH,1/60,s.spatialRevRate,s.spatialRevMode,s.walls,s.wallSolidity,s.spatialHeatMode);enforceWalls(s.ps,s.walls,s.wallSolidity,0.98);wallThermalTransfer(s.ps,s.walls,1/60,s.wallThermalPerm);}
          else{physicsStep(s.ps,simW,simH,1/60,s.mode,s.rest,s.coup,s.walls,s.thermRev,s.thermRevRate,s.wallSolidity);rxnStep(s.ps,1/60,s.mode,12,s.rxn,s.eam,s.isrxn);if(s.thermRev&&(s.mode==="mixed_physical"||s.mode==="mixed_cinematic"))antiFourierStep(s.ps,simW,simH,1/60,s.thermRevRate);if(s.spatialRev&&(s.mode==="mixed_physical"||s.mode==="mixed_cinematic"))antiDiffusionStep(s.ps,simW,simH,1/60,s.spatialRevRate,s.spatialRevMode,s.walls,s.wallSolidity,s.spatialHeatMode);enforceWalls(s.ps,s.walls,s.wallSolidity,0.98);wallThermalTransfer(s.ps,s.walls,1/60,s.wallThermalPerm);}
          s.frame++;bump();
        }} style={{flex:.6,padding:"10px 0",borderRadius:6,border:"none",background:"#1e1e2e",color:"#889",fontFamily:"inherit",fontWeight:600,fontSize:11,cursor:"pointer"}}>
          Adım→
        </button>
        <button onClick={()=>load(s.lastP||"hot_cold")}
          style={{flex:.6,padding:"10px 0",borderRadius:6,border:"none",background:"#2a2010",color:"#c90",fontFamily:"inherit",fontWeight:600,fontSize:11,cursor:"pointer"}}>↺</button>
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
          {/* Hız: özel çift bölgeli slider — ortası 1×, sol yarı 0.01-1, sağ yarı 1-100 */}
          <div style={{marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#778",marginBottom:2}}>
              <span>Hız</span>
              <span style={{color:"#aab"}}>{
                s.spdRaw===0?"⏹ Durdur":
                (()=>{
                  const v = s.spdRaw<=500 ? 0.01+(s.spdRaw-1)/499*0.99 : 1+(s.spdRaw-500)/500*99;
                  return s.spdRaw<=0?"⏹ Durdur": v<1?v.toFixed(2)+"×":v<10?v.toFixed(1)+"×":Math.round(v)+"×";
                })()
              }</span>
            </div>
            <input type="range" min={0} max={1000} step={1} value={s.spdRaw}
              onChange={e=>{
                const raw=parseInt(e.target.value);
                s.spdRaw=raw;
                if(raw===0){s.spd=0;}
                else if(raw<=500){s.spd=0.01+(raw-1)/499*0.99;}
                else{s.spd=1+(raw-500)/500*99;}
                bump();
              }}
              style={{width:"100%",height:6,accentColor:"#3070d0",cursor:"pointer"}}/>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:7,color:"#334",marginTop:1}}>
              <span>⏹</span><span>0.01×</span><span style={{color:"#5080c0"}}>▼ 1×</span><span>50×</span><span>100×</span>
            </div>
          </div>
          <Sl label="Normal ●" value={s.pCntNorm} min={0} max={200} step={1} fmt={v=>v.toFixed(0)+" parçacık"} onChange={v=>{s.pCntNorm=v;bump();}}/>
          <Sl label="Ters ◆" value={s.pCntRev} min={0} max={200} step={1} fmt={v=>v.toFixed(0)+" parçacık"} onChange={v=>{s.pCntRev=v;bump();}}/>
          <div style={{fontSize:8,color:"#556",marginBottom:4}}>Toplam: {s.pCntNorm+s.pCntRev} parçacık (değişiklik sıfırlamada uygulanır)</div>
          <Sl label="Elastiklik" value={s.rest} min={0} max={1} step={.01} fmt={v=>v.toFixed(2)} onChange={v=>{s.rest=v;bump();}}/>
          <Sl label="Kuplaj κ" value={s.coup} min={0} max={1} step={.05} fmt={v=>v.toFixed(2)} onChange={v=>{s.coup=v;bump();}}/>
          <Sl label="Ea çarpanı" value={s.eam} min={0} max={3} step={.1} fmt={v=>v.toFixed(1)} onChange={v=>{s.eam=v;bump();}}/>
          <div style={{display:"flex",flexWrap:"wrap",gap:8,marginTop:8}}>
            <Tg label="Reaksiyonlar" v={s.rxn} set={v=>{s.rxn=v;if(v)seedReactants(s.ps);bump();}}/>
            <Tg label="Termal Ters ⚡" v={s.thermRev} set={v=>{s.thermRev=v;bump();}}/>
            <Tg label="Uzamsal Ters 🌀" v={s.spatialRev} set={v=>{s.spatialRev=v;bump();}}/>
            <Tg label="Hız vektör" v={s.showVel} set={v=>{s.showVel=v;bump();}}/>
            <Tg label="Sıcaklık bg" v={s.showTBg} set={v=>{s.showTBg=v;bump();}}/>
            <Tg label="Entropi map" v={s.showEMap} set={v=>{s.showEMap=v;bump();}}/>
            <Tg label="Bölme duvarı" v={s.walls.length>0} set={v=>{s.walls=v?[{x1:simW/2,y1:0,x2:simW/2,y2:simH}]:[];for(const p of s.ps)delete p._wallSide;bump();}}/>
          </div>
          {s.thermRev&&(
            <div style={{marginTop:6}}>
              <Sl label="Anti-Fourier şiddeti" value={s.thermRevRate} min={0} max={1.0} step={.02} fmt={v=>v.toFixed(2)} onChange={v=>{s.thermRevRate=v;bump();}}/>
              <div style={{fontSize:8,color:"#665",marginTop:2}}>Sıcak enerji çalar, soğuk kaybeder → ısı tek cisme toplanır</div>
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
              <Sl label="Anti-difüzyon şiddeti" value={s.spatialRevRate} min={0} max={1} step={.05} fmt={v=>v.toFixed(2)} onChange={v=>{s.spatialRevRate=v;bump();}}/>
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
            </div>
          )}
        </div>)}

        {tab==="preset"&&(<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
          {[["hot_cold","🌡 Sıcak-Soğuk","Sol sıcak, sağ soğuk"],
            ["reverse","⏪ Reverse","Kümelenme→dağılım tersi"],
            ["therm_rev","🔥❄ Termal Ters","Anti-Fourier kutuplaşma"],
            ["therm_mixed","⚡ Termal Karma","Normal vs Anti-Fourier"],
            ["full_rev","🌀 Tam Ters","Uzamsal+termal tam reverse"],
            ["full_mixed","🔬 Tam Karma","Normal vs tam ters yan yana"],
            ["rxn_ab","⚗ A+B Reaksiyon","Sentez deneyi"],
            ["mixed_w","🔗 Karma Zayıf","Düşük κ karma"],
            ["mixed_d","💥 Karma Bozulma","Yüksek κ decoherence"],
            ["partition","🧱 Bölme Kaldır","Karışma senaryosu"],
            ["endo_exo","🔥 Endo vs Ekzo","Reaksiyon karşılaştırma"]
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
          <div style={{height:6}}/><Row l="Toplam E" v={tE.toFixed(1)}/><Row l="  Kinetik" v={tK.toFixed(1)}/><Row l="Ort. T" v={avgT.toFixed(2)}/>
          <div style={{height:6}}/><Row l="Entropi (≈)" v={calcEntropy(s.ps,simW,simH).toFixed(2)}/>
          {nR>0&&<Row l="Decoherence" v={dec.toFixed(2)} c={dec>.7?"#f44":dec>.4?"#f80":"#8a8"}/>}
          {s.mode==="reverse"&&s.revMode==="playback"&&s.revF&&(
            <Row l="Playback" v={`${Math.round(s.revI/(s.revF.length-1)*100)}%`} c="#88a"/>
          )}
          <div style={{height:6}}/><Row l="Reaksiyonlar" v={s.rxnT}/>
          <div style={{height:8}}/>
          <div style={{display:"flex",gap:6,fontSize:8,color:"#556",flexWrap:"wrap"}}>
            <span>● Normal</span><span style={{color:"#b466ff"}}>◆ Reverse</span>
          </div>
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

function Sl({label,value,min,max,step,fmt,onChange}){
  return(<div style={{marginBottom:8}}>
    <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#778",marginBottom:2}}><span>{label}</span><span style={{color:"#aab"}}>{fmt(value)}</span></div>
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
