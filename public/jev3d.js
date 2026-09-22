/* Jev, a projected hologram droid that reacts to verdicts.
   Procedural geometry only (no model files), wireframe + additive glow. */
export function mountJev(canvas){
  const T = window.THREE;
  if(!T || !canvas) return null;
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const scene = new T.Scene();
  const cam = new T.PerspectiveCamera(42, 1, .1, 100);
  cam.position.set(0, .25, 5.4);

  const renderer = new T.WebGLRenderer({canvas, alpha:true, antialias:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const CY=0xF0B90B, OK=0x3FD98A, WARN=0xFFA726, BAD=0xFF6B6B;
  const rig = new T.Group(); scene.add(rig);
  const body = new T.Group(); rig.add(body);

  const line = (geo,color,op)=> new T.LineSegments(
    new T.EdgesGeometry(geo), new T.LineBasicMaterial({color,transparent:true,opacity:op}));
  const glow = (geo,color,op)=> new T.Mesh(geo,
    new T.MeshBasicMaterial({color,transparent:true,opacity:op,blending:T.AdditiveBlending,depthWrite:false}));

  /* head: an octahedron cage with a bright core */
  const head = new T.Group(); head.position.y = .95;
  head.add(line(new T.OctahedronGeometry(.62,0), CY, .95));
  head.add(glow(new T.OctahedronGeometry(.58,0), CY, .10));
  const core = glow(new T.SphereGeometry(.17,18,18), CY, .85); head.add(core);
  /* single sweeping eye */
  const eye = glow(new T.SphereGeometry(.075,14,14), CY, 1); eye.position.set(0,.02,.56); head.add(eye);
  body.add(head);

  /* torso: tapered cage */
  const torso = line(new T.CylinderGeometry(.42,.56,1.05,6,1,true), CY, .75);
  torso.position.y = -.05; body.add(torso);
  body.add(glow(new T.CylinderGeometry(.40,.54,1.0,6,1,true), CY, .05));

  /* shoulder pods, animated on state */
  const pods=[];
  [-1,1].forEach(s=>{
    const p = line(new T.BoxGeometry(.26,.26,.26), CY, .8);
    p.position.set(s*.72,.12,0); body.add(p); pods.push(p);
  });

  /* projector base rings */
  const rings=[];
  [1.05,1.45,1.85].forEach((r,i)=>{
    const g=new T.RingGeometry(r,r+.012,72);
    const m=new T.MeshBasicMaterial({color:CY,transparent:true,opacity:.5-i*.13,
      side:T.DoubleSide,blending:T.AdditiveBlending,depthWrite:false});
    const ring=new T.Mesh(g,m); ring.rotation.x=-Math.PI/2; ring.position.y=-1.15;
    scene.add(ring); rings.push(ring);
  });

  /* orbiting judgment particles, one per question in flight */
  const P=90, pos=new Float32Array(P*3), seed=[];
  for(let i=0;i<P;i++){
    seed.push({r:1.3+Math.random()*1.5, a:Math.random()*Math.PI*2,
               y:-1.1+Math.random()*2.6, s:.15+Math.random()*.5});
    pos[i*3]=0;pos[i*3+1]=0;pos[i*3+2]=0;
  }
  const pg=new T.BufferGeometry(); pg.setAttribute("position",new T.BufferAttribute(pos,3));
  const particles=new T.Points(pg,new T.PointsMaterial({color:CY,size:.045,transparent:true,
    opacity:.75,blending:T.AdditiveBlending,depthWrite:false}));
  scene.add(particles);

  /* ---- reactive state ---- */
  const S={mood:"idle",target:new T.Color(CY),spin:.25,bob:1,pulse:0,activity:.25,lean:0};
  function setColor(hex){ S.target.setHex(hex); }
  const api={
    idle(){ S.mood="idle"; S.spin=.25; S.activity=.25; S.lean=0; setColor(CY); },
    thinking(){ S.mood="thinking"; S.spin=1.5; S.activity=1; S.lean=0; setColor(CY); },
    /* p: 0..1 confidence/probability of the verdict */
    verdict(p, kind){
      S.mood="verdict"; S.spin=.35; S.activity=.45; S.pulse=1;
      S.lean = kind==="yes" ? -.16 : kind==="no" ? .16 : 0;
      setColor(kind==="yes"?OK:kind==="no"?BAD:WARN);
      S.conf = p;
    },
    error(){ S.mood="error"; S.spin=.1; S.activity=.1; S.pulse=1; setColor(BAD); }
  };

  const cur=new T.Color(CY);
  let t=0, raf=0;
  function resize(){
    const w=canvas.clientWidth||320, h=canvas.clientHeight||260;
    if(canvas.width!==w*renderer.getPixelRatio()||canvas.height!==h*renderer.getPixelRatio()){
      renderer.setSize(w,h,false); cam.aspect=w/h; cam.updateProjectionMatrix();
    }
  }
  function frame(){
    raf=requestAnimationFrame(frame);
    resize();
    t += REDUCED ? 0 : 1/60;

    cur.lerp(S.target,.06);
    [torso,...pods].forEach(o=>o.material.color.copy(cur));
    head.children.forEach(c=>c.material.color.copy(cur));
    particles.material.color.copy(cur);
    rings.forEach(r=>r.material.color.copy(cur));

    rig.rotation.y = t*S.spin;
    body.position.y = Math.sin(t*1.6)*.05*S.bob;
    body.rotation.x += (S.lean - body.rotation.x)*.06;
    head.rotation.y = Math.sin(t*.8)*.25;
    head.rotation.z = Math.sin(t*.6)*.06;

    /* eye sweeps while thinking, locks forward on a verdict */
    const sweep = S.mood==="thinking" ? Math.sin(t*5)*.45 : Math.sin(t*.7)*.12;
    eye.position.x = Math.sin(sweep)*.5; eye.position.z = Math.cos(sweep)*.56;

    /* pulse on arrival */
    if(S.pulse>0){ S.pulse=Math.max(0,S.pulse-.018);
      const k=1+S.pulse*.55; core.scale.setScalar(k);
      core.material.opacity=.55+S.pulse*.45;
    } else {
      const b=1+Math.sin(t*2.4)*.08; core.scale.setScalar(b);
      core.material.opacity = S.mood==="verdict" ? .6+ (S.conf??.5)*.35 : .7;
    }

    pods.forEach((p,i)=>{
      p.rotation.x=t*(.9+i*.3)*S.activity*2;
      p.rotation.y=t*(.7+i*.4)*S.activity*2;
      p.position.y=.12+Math.sin(t*2+i*Math.PI)*.07*S.activity;
    });

    const arr=pg.attributes.position.array;
    for(let i=0;i<P;i++){
      const s=seed[i], a=s.a + t*s.s*(S.mood==="thinking"?2.6:.7);
      const r=s.r*(S.mood==="thinking"?.82:1);
      arr[i*3]=Math.cos(a)*r;
      arr[i*3+1]=s.y+Math.sin(t*.9+i)*.09;
      arr[i*3+2]=Math.sin(a)*r;
    }
    pg.attributes.position.needsUpdate=true;
    particles.material.opacity = .28 + S.activity*.5;

    rings.forEach((rg,i)=>{ rg.rotation.z=t*(.18+i*.1)*(i%2?-1:1);
      rg.material.opacity=(.5-i*.13)*(.55+S.activity*.5); });

    renderer.render(scene,cam);
  }
  frame();
  return {...api, dispose(){cancelAnimationFrame(raf); renderer.dispose();}};
}
