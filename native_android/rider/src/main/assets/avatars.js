// Scraveit rider avatars: shared scooter and box; three women's, three men's and one neutral rider.
// Shared by the customer app (live map) and the rider app (avatar picker).
THREE.ColorManagement.legacyMode=false;
window.AV=(function(){
  const gradientMap=(()=>{const d=new Uint8Array([165,215,255]);const t=new THREE.DataTexture(d,3,1,THREE.RedFormat);
    t.minFilter=t.magFilter=THREE.NearestFilter;t.needsUpdate=true;return t;})();
  const cache={};
  const toon=c=>cache[c]||(cache[c]=new THREE.MeshToonMaterial({color:c,gradientMap}));
  const basic=(c,extra={})=>new THREE.MeshBasicMaterial(Object.assign({color:c},extra));
  const INK=0x2B3A67, OUTLINE=basic(INK,{side:THREE.BackSide});
  const Y=new THREE.Vector3(0,1,0);
  function shade(o){o.traverse(n=>{if(n.isMesh&&n.material!==OUTLINE){n.castShadow=true;n.receiveShadow=true;}});return o;}
  function line(mesh,s=1.045){const o=new THREE.Mesh(mesh.geometry,OUTLINE);o.scale.setScalar(s);mesh.add(o);return mesh;}
  function rrect(w,h,rc){const s=new THREE.Shape(),x=-w/2,y=-h/2;rc=Math.min(rc,w/2,h/2);
    s.moveTo(x+rc,y);s.lineTo(x+w-rc,y);s.quadraticCurveTo(x+w,y,x+w,y+rc);s.lineTo(x+w,y+h-rc);
    s.quadraticCurveTo(x+w,y+h,x+w-rc,y+h);s.lineTo(x+rc,y+h);s.quadraticCurveTo(x,y+h,x,y+h-rc);
    s.lineTo(x,y+rc);s.quadraticCurveTo(x,y,x+rc,y);return s;}
  function rbox(w,h,d,r,m,outline=true){
    const g=new THREE.ExtrudeGeometry(rrect(w-2*r,h-2*r,Math.min(w,h)*0.22),{depth:Math.max(0.002,d-2*r),bevelEnabled:true,bevelSize:r,bevelThickness:r,bevelSegments:4,curveSegments:8});
    g.center();const mesh=new THREE.Mesh(g,m);if(outline)line(mesh,1.03);return shade(mesh);}
  function ball(r,m,sx=1,sy=1,sz=1,outline=true){const mesh=new THREE.Mesh(new THREE.SphereGeometry(r,32,20),m);mesh.scale.set(sx,sy,sz);if(outline)line(mesh);return shade(mesh);}
  function limb(a,b,r,m,outline=true){
    const A=new THREE.Vector3(...a),B=new THREE.Vector3(...b),dir=B.clone().sub(A),len=dir.length();
    const mesh=new THREE.Mesh(new THREE.CapsuleGeometry(r,Math.max(0.001,len),6,14),m);
    mesh.position.copy(A).add(B).multiplyScalar(0.5);mesh.quaternion.setFromUnitVectors(Y,dir.normalize());
    if(outline)line(mesh,1.08);return shade(mesh);}
  function at(o,x,y,z){o.position.set(x,y,z);return o;}
  function heartShape(s){const h=new THREE.Shape();h.moveTo(0,-0.9*s);
    h.bezierCurveTo(-0.15*s,-0.65*s,-1.0*s,-0.2*s,-1.0*s,0.3*s);h.bezierCurveTo(-1.0*s,0.85*s,-0.3*s,1.05*s,0,0.55*s);
    h.bezierCurveTo(0.3*s,1.05*s,1.0*s,0.85*s,1.0*s,0.3*s);h.bezierCurveTo(1.0*s,-0.2*s,0.15*s,-0.65*s,0,-0.9*s);return h;}
  function star(s,m){const sh=new THREE.Shape();for(let i=0;i<10;i++){const r=i%2?s*0.45:s,a=Math.PI/2+i*Math.PI/5;i?sh.lineTo(Math.cos(a)*r,Math.sin(a)*r):sh.moveTo(Math.cos(a)*r,Math.sin(a)*r);}
    const g=new THREE.ExtrudeGeometry(sh,{depth:0.01,bevelEnabled:true,bevelSize:s*0.12,bevelThickness:s*0.12,bevelSegments:2});g.center();const mesh=new THREE.Mesh(g,m);line(mesh,1.08);return shade(mesh);}
  function heart(s,m,depth=0.01){const g=new THREE.ExtrudeGeometry(heartShape(s),{depth,bevelEnabled:true,bevelSize:s*0.18,bevelThickness:s*0.18,bevelSegments:3,curveSegments:16});
    g.center();const mesh=new THREE.Mesh(g,m);line(mesh,1.06);return shade(mesh);}

  // decals shared by every avatar: the box's face and the wordmark
  const decals=[];
  function decal(draw,w,h){const cv=document.createElement('canvas');cv.width=w;cv.height=h;
    const tex=new THREE.CanvasTexture(cv);tex.encoding=THREE.sRGBEncoding;tex.anisotropy=8;
    const paint=()=>{const c=cv.getContext('2d');c.clearRect(0,0,w,h);draw(c);tex.needsUpdate=true;};paint();decals.push(paint);
    return basic(0xffffff,{map:tex,transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2});}
  const word=(c,x,y,size)=>{c.fillStyle='#FFFFFF';c.textAlign='center';c.textBaseline='middle';c.font="800 "+size+"px Manrope, 'DM Sans', Arial, sans-serif";c.fillText('Scraveit',x,y);};
  const faceDecal=decal(c=>{
    c.fillStyle='#1D2240';[[150,190],[362,190]].forEach(([x,y])=>{c.beginPath();c.ellipse(x,y,30,40,0,0,Math.PI*2);c.fill();});
    c.fillStyle='#FFFFFF';[[162,174],[374,174]].forEach(([x,y])=>{c.beginPath();c.arc(x,y,11,0,Math.PI*2);c.fill();});
    c.fillStyle='rgba(255,143,168,0.85)';[[92,262],[420,262]].forEach(([x,y])=>{c.beginPath();c.ellipse(x,y,38,22,0,0,Math.PI*2);c.fill();});
    c.strokeStyle='#1D2240';c.lineWidth=12;c.lineCap='round';c.beginPath();c.arc(256,236,34,0.15*Math.PI,0.85*Math.PI);c.stroke();
    word(c,256,410,70);},512,512);
  const sideDecal=decal(c=>{word(c,230,128,104);
    c.fillStyle='#FF8FB8';c.save();c.translate(470,120);c.scale(1.6,1.6);c.beginPath();c.moveTo(0,14);
    c.bezierCurveTo(-4,10,-16,3,-16,-5);c.bezierCurveTo(-16,-14,-5,-16,0,-8);c.bezierCurveTo(5,-16,16,-14,16,-5);c.bezierCurveTo(16,3,4,10,0,14);c.fill();c.restore();},560,240);
  const repaint=()=>decals.forEach(p=>p());

  const PRESETS=[
    {id:'bloom',name:'Bloom',gender:'f',rider:'Priya',helmet:0xFF8FB8,soft:0xFFD3E3,ears:'cat',goggles:0x8FE3CF,pants:0x8C7BE8,hair:0x2A1A16,skin:0xE3A882,accent:0xFF8FB8},
    {id:'lilac',name:'Lilac',gender:'f',rider:'Ananya',helmet:0xB6A0FF,soft:0xE8E0FF,ears:'none',sticker:true,goggles:0xFFC3D8,pants:0x2B3A67,hair:0x3A211A,skin:0xD3976F,accent:0xFFB3CF},
    {id:'mint',name:'Mint',gender:'f',rider:'Meera',helmet:0x7FD8C1,soft:0xD8F6EE,ears:'bear',goggles:0xFFD27A,pants:0x5C6B8A,hair:0x1E1411,skin:0xC4875F,accent:0xFF9E7A},
    {id:'classic',name:'Classic',gender:'m',rider:'Ravi',helmet:0x3F7BFF,soft:0xFFFFFF,stripe:0xFFFFFF,pants:0x3A4258,hair:0x1C1210,skin:0xD39468,accent:0xFFFFFF},
    {id:'midnight',name:'Midnight',gender:'m',rider:'Arjun',helmet:0x26314F,soft:0xA9C6FF,stripe:0x6E9BFF,pants:0x22283A,hair:0x120C0B,skin:0xB57750,accent:0xA9C6FF},
    {id:'forest',name:'Forest',gender:'m',rider:'Kabir',helmet:0x5FB585,soft:0xF4EAD5,stripe:0xF4EAD5,pants:0x4D5A4A,hair:0x2A1C14,skin:0xDDA078,accent:0xF4EAD5},
    // Default: exactly the men's Classic look, shown under its own tab and given to riders who never pick.
    {id:'blue',name:'Default',gender:'n',look:'m',rider:'Ravi',helmet:0x3F7BFF,soft:0xFFFFFF,stripe:0xFFFFFF,pants:0x3A4258,hair:0x1C1210,skin:0xD39468,accent:0xFFFFFF}];

  const BLUE=0x3F7BFF;
  function build(p,pose='ride'){
    const G=p.look||p.gender;
    const M={body:toon(BLUE),baby:toon(0xA9C6FF),pink:toon(0xFF8FB8),mint:toon(0x8FE3CF),cream:toon(0xFFF6EC),ink:toon(INK),white:toon(0xFFFFFF),
      jacket:toon(BLUE),pants:toon(p.pants),skin:toon(p.skin),hair:toon(p.hair),helmet:toon(p.helmet),soft:toon(p.soft),accent:toon(p.accent),
      eye:basic(0x1D2240),light:basic(0xFFF4C8),tail:basic(0xFF5C8A),
      blush:basic(0xFF7F9A,{transparent:true,opacity:G==='f'?0.7:G==='n'?0.55:0.4,depthWrite:false}),
      lips:basic(G==='f'?0xD9506E:0x1D2240),
      lens:new THREE.MeshToonMaterial({color:0xBFE6FF,gradientMap,transparent:true,opacity:0.85})};
    const rider=new THREE.Group(),lean=new THREE.Group(),bike=new THREE.Group(),person=new THREE.Group();
    rider.add(lean);lean.add(bike,person);lean.position.x=0.06;
    const R=0.29,wheels=[];
    function wheel(){const g=new THREE.Group();
      g.add(new THREE.Mesh(new THREE.TorusGeometry(0.2,0.09,16,40),M.ink));
      const rim=new THREE.Mesh(new THREE.CylinderGeometry(0.15,0.15,0.13,28),M.mint);rim.rotation.x=Math.PI/2;g.add(rim);
      const cap=new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.05,0.16,16),M.cream);cap.rotation.x=Math.PI/2;g.add(cap);
      for(let i=0;i<5;i++){const d=new THREE.Mesh(new THREE.CylinderGeometry(0.022,0.022,0.15,10),M.cream);d.rotation.x=Math.PI/2;d.position.set(Math.cos(i*1.2566)*0.1,Math.sin(i*1.2566)*0.1,0);g.add(d);}
      return shade(g);}
    const rw=at(wheel(),-0.5,R,0),fw=at(wheel(),0.56,R,0);wheels.push(rw,fw);bike.add(rw,fw);
    bike.add(at(rbox(0.56,0.09,0.36,0.035,M.body),0.06,0.4,0));
    bike.add(at(ball(0.3,M.body,1.45,1.0,1.05),-0.42,0.62,0));
    [1,-1].forEach(s=>{const hm=at(heart(0.07,M.pink),-0.43,0.62,0.31*s);hm.rotation.y=s>0?0:Math.PI;bike.add(hm);});
    bike.add(at(rbox(0.52,0.11,0.32,0.05,M.ink),-0.3,0.9,0));
    const shield=at(rbox(0.14,0.66,0.42,0.06,M.body),0.4,0.7,0);shield.rotation.z=-0.22;bike.add(shield);
    bike.add(at(ball(0.21,M.body,1.3,0.75,1.0),0.58,0.46,0));
    bike.add(limb([0.46,0.95,0],[0.38,1.06,0],0.04,M.body));
    bike.add(at(rbox(0.13,0.08,0.56,0.04,M.body),0.38,1.08,0));
    bike.add(limb([0.38,1.08,0.24],[0.38,1.08,0.32],0.03,M.accent),limb([0.38,1.08,-0.24],[0.38,1.08,-0.32],0.03,M.accent));
    bike.add(at(ball(0.085,M.light,1,1,1),0.47,1.08,0));
    [1,-1].forEach(s=>{bike.add(limb([0.36,1.1,0.24*s],[0.33,1.23,0.29*s],0.012,M.ink,false));bike.add(at(ball(0.05,M.soft,0.5,1,1),0.33,1.26,0.3*s));});
    bike.add(at(ball(0.04,M.tail,1,0.8,1.4,false),-0.84,0.66,0));
    if(pose!=='ride')bike.add(limb([-0.12,0.34,-0.13],[-0.2,0.02,-0.3],0.022,M.ink,false));
    // the delivery box
    bike.add(at(rbox(0.5,0.46,0.48,0.1,M.body),-0.62,1.15,0));
    bike.add(at(rbox(0.52,0.07,0.5,0.03,M.baby),-0.62,1.4,0));
    const lidHeart=at(heart(0.07,M.pink),-0.62,1.445,0);lidHeart.rotation.x=-Math.PI/2;lidHeart.rotation.z=Math.PI/2;bike.add(lidHeart);
    const face=at(new THREE.Mesh(new THREE.PlaneGeometry(0.4,0.4),faceDecal),-0.874,1.15,0);face.rotation.y=-Math.PI/2;bike.add(face);
    const sd=new THREE.PlaneGeometry(0.4,0.17);
    const sL=at(new THREE.Mesh(sd,sideDecal),-0.62,1.15,0.243),sR=at(new THREE.Mesh(sd,sideDecal),-0.62,1.15,-0.243);sR.rotation.y=Math.PI;bike.add(sL,sR);
    const antenna=at(new THREE.Group(),-0.72,1.43,0.12);bike.add(antenna);
    antenna.add(limb([0,0,0],[0,0.2,0],0.01,M.ink,false));
    const topHeart=at(heart(0.06,M.pink,0.03),0,0.27,0);topHeart.rotation.y=Math.PI/2;antenna.add(topHeart);

    // the rider's body: Scraveit blue jacket for everyone
    person.add(at(rbox(0.3,0.16,0.3,0.07,M.pants),-0.2,0.86,0));
    person.add(limb([-0.2,0.88,0],[-0.13,1.05,0],0.16,M.jacket));
    const collar=at(new THREE.Mesh(new THREE.TorusGeometry(0.085,0.03,10,24),M.white),-0.1,1.17,0);collar.rotation.x=Math.PI/2;collar.rotation.y=0.3;person.add(shade(collar));
    const patch=at(new THREE.Mesh(new THREE.CircleGeometry(0.04,24),M.white),0.03,1.04,0.09);patch.rotation.y=0.9;person.add(patch);
    if(G==='f')person.add(at(ball(0.12,M.jacket,1,0.5,1.3),-0.24,1.16,0));
    const right=pose==='wave';
    [1,-1].forEach(s=>{
      if(right&&s===1){person.add(limb([-0.1,1.08,0.15],[0.0,1.26,0.3],0.055,M.jacket));person.add(limb([0.0,1.26,0.3],[0.05,1.48,0.33],0.05,M.jacket));
        person.add(at(ball(0.062,M.accent),0.06,1.54,0.34));}
      else{person.add(limb([-0.1,1.06,0.15*s],[0.12,1.0,0.22*s],0.055,M.jacket));person.add(limb([0.12,1.0,0.22*s],[0.32,1.07,0.27*s],0.05,M.jacket));
        person.add(at(ball(0.058,M.accent),0.36,1.08,0.28*s));}
      const footDown=pose!=='ride'&&s===-1;
      const knee=footDown?[0.04,0.74,0.2*s]:[0.06,0.78,0.13*s], foot=footDown?[0.08,0.1,0.34*s]:[0.12,0.5,0.13*s];
      person.add(limb([-0.2,0.86,0.1*s],knee,0.07,M.pants));person.add(limb(knee,foot,0.06,M.pants));
      person.add(at(rbox(0.19,0.09,0.11,0.04,M.white),foot[0]+0.04,foot[1]-0.035,foot[2]));
      person.add(at(rbox(0.19,0.03,0.11,0.012,M.accent,false),foot[0]+0.04,foot[1]-0.08,foot[2]));
    });

    // head, helmet, hair and face
    const head=at(new THREE.Group(),-0.06,1.38,0);person.add(head);
    head.add(ball(0.25,M.skin));
    const H=0.28;
    const cap=new THREE.Mesh(new THREE.SphereGeometry(H,40,24,0,Math.PI*2,0,1.2),M.helmet);line(cap,1.03);
    const shell=new THREE.Mesh(new THREE.SphereGeometry(H,40,20,Math.PI+1.3,Math.PI*2-2.6,1.2,0.75),M.helmet);
    const inner=new THREE.Mesh(shell.geometry,basic(0x000000,{side:THREE.BackSide,transparent:true,opacity:0.25}));
    head.add(shade(cap),shade(shell),inner);
    const rim=new THREE.Mesh(new THREE.TorusGeometry(H*Math.sin(1.2)+0.004,0.016,8,48),M.soft);rim.rotation.x=Math.PI/2;rim.position.y=H*Math.cos(1.2);head.add(shade(rim));
    if(p.ears==='cat')[1,-1].forEach(s=>{const e=at(new THREE.Group(),-0.03,0.24,0.15*s);e.rotation.x=0.42*s;
      e.add(shade(new THREE.Mesh(new THREE.ConeGeometry(0.11,0.19,20),M.helmet)),at(new THREE.Mesh(new THREE.ConeGeometry(0.062,0.12,16),M.soft),0.05,-0.02,0));head.add(e);});
    if(p.ears==='bear')[1,-1].forEach(s=>{const e=at(ball(0.075,M.helmet,0.55,1,1),-0.04,0.25,0.16*s);e.rotation.x=0.5*s;head.add(e);
      const ei=at(ball(0.045,M.soft,0.4,1,1,false),0.0,0.25,0.16*s);ei.position.x=-0.01;ei.rotation.x=0.5*s;head.add(ei);});
    if(p.sticker)[1,-1].forEach(s=>{const hs=at(p.sticker==='star'?star(0.06,toon(0xFFFFFF)):heart(0.05,M.pink),-0.02,0.12,0.265*s);hs.rotation.y=s>0?0.1:Math.PI-0.1;head.add(hs);});
    if(G==='f'){
      [1,-1].forEach(s=>{const g=at(new THREE.Mesh(new THREE.TorusGeometry(0.052,0.017,10,24),toon(p.goggles)),0.19,0.19,0.075*s);g.rotation.y=Math.PI/2;g.rotation.x=-0.5;
        const l=at(ball(0.047,M.lens,0.45,1,1,false),0.19,0.19,0.075*s);l.rotation.z=-0.5;head.add(shade(g),l);});
    } else {
      if(p.stripe){const stripe=new THREE.Mesh(new THREE.TorusGeometry(H+0.003,0.024,8,48,Math.PI-0.62),toon(p.stripe));stripe.rotation.z=0.62;head.add(shade(stripe));}
      if(G==='m'){const brim=at(rbox(0.09,0.022,0.26,0.009,M.helmet),0.25,0.17,0);brim.rotation.z=-0.55;head.add(brim);}
    }
    // hair
    if(G!=='m'){
      [[0.222,0.075,0.03,0.07],[0.215,0.07,0.1,0.065],[0.215,0.075,-0.06,0.066],[0.19,0.065,0.16,0.06],[0.19,0.06,-0.155,0.06]].forEach(([x,y,z,r])=>head.add(at(ball(r,M.hair,0.5,0.55,1,false),x,y,z)));
      [1,-1].forEach(s=>head.add(limb([0.13,0.05,0.2*s],G==='n'?[0.11,-0.09,0.22*s]:[0.1,-0.2,0.215*s],G==='n'?0.04:0.03,M.hair,false)));
      if(G==='n')head.add(at(ball(0.2,M.hair,0.5,0.45,1.1,false),-0.12,-0.08,0));
    } else {
      [[0.225,0.08,0.02,0.06],[0.215,0.085,0.1,0.05],[0.215,0.08,-0.08,0.055]].forEach(([x,y,z,r])=>head.add(at(ball(r,M.hair,0.45,0.45,1.2,false),x,y,z)));
      [1,-1].forEach(s=>head.add(at(rbox(0.05,0.1,0.03,0.012,M.hair,false),0.07,-0.02,0.24*s)));
    }
    let pony=null;
    if(G==='f'){pony=at(new THREE.Group(),-0.27,0.02,0);head.add(pony);
      const tie=at(new THREE.Mesh(new THREE.TorusGeometry(0.05,0.018,8,20),M.accent),0,0,0);tie.rotation.y=Math.PI/2;pony.add(shade(tie));
      pony.add(at(ball(0.075,M.hair),-0.06,-0.06,0),at(ball(0.065,M.hair),-0.1,-0.16,0),at(ball(0.05,M.hair),-0.12,-0.25,0));}
    // face
    [1,-1].forEach(s=>{
      head.add(at(ball(0.04,M.eye,0.55,1.25,1,false),0.226,0.0,0.08*s));
      head.add(at(ball(0.012,M.white,1,1,1,false),0.247,0.025,0.071*s),at(ball(0.006,M.white,1,1,1,false),0.248,-0.018,0.09*s));
      const bw=G==='f'?0.007:G==='n'?0.01:0.013;
      const brow=limb([0.236,0.072,0.05*s],[0.228,G==='f'?0.082:0.07,0.115*s],bw,M.eye,false);head.add(brow);
      if(G==='f')head.add(limb([0.226,0.045,0.112*s],[0.215,0.06,0.13*s],0.006,M.eye,false));
      const b=at(new THREE.Mesh(new THREE.CircleGeometry(0.038,20),M.blush),0.205,-0.065,0.14*s);b.rotation.y=Math.atan2(0.8,0.6*s);head.add(b);
    });
    const mouth=at(new THREE.Mesh(new THREE.TorusGeometry(0.03,0.008,6,16,Math.PI),M.lips),0.24,-0.07,0);mouth.rotation.set(0,Math.PI/2,Math.PI);head.add(mouth);

    // no self-shadowing on the face: helmet and hair shadows made it look smudged
    head.traverse(n=>{if(n.isMesh)n.receiveShadow=false;});
    function tick(t){head.position.y=1.38+Math.sin(t*3.2)*0.012;head.rotation.z=Math.sin(t*1.6)*0.04;
      antenna.rotation.x=Math.sin(t*2.4)*0.18;topHeart.scale.setScalar(1+Math.max(0,Math.sin(t*4.8))*0.12);
      if(pony){pony.rotation.x=Math.sin(t*2.8)*0.25;pony.rotation.z=0.15+Math.sin(t*3.1)*0.08;}}
    return {rider,lean,wheels,tick,head};
  }
  return {PRESETS,build,repaint};
})();
