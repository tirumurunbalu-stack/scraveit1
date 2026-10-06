// The 3D rider on the live tracking map. One small WebGL canvas floats over the
// map at the rider pin's on-screen position (read from the pin itself, so it
// follows the map's pan, tilt and rotation for free) and draws the rider's
// chosen avatar facing the way they are really travelling.
window.Rider3D=(function(){
  if(!window.THREE||!window.AV)return null;
  const BUF=220;
  const cache={};
  let renderer=null,scene=null,camera=null,canvas=null,hemi=null,sun=null,ground=null,beam=null;
  let current=null,currentKey="",provider=null,raf=0,lastFrame=0,failed=false;
  const look={rel:null,lean:0};

  function blobTexture(){const c=document.createElement("canvas");c.width=c.height=64;const g=c.getContext("2d");
    const r=g.createRadialGradient(32,32,2,32,32,32);r.addColorStop(0,"rgba(14,27,61,0.42)");r.addColorStop(1,"rgba(14,27,61,0)");
    g.fillStyle=r;g.fillRect(0,0,64,64);return new THREE.CanvasTexture(c);}
  function init(){
    if(renderer)return true;
    if(failed)return false;
    try{
      canvas=document.createElement("canvas");canvas.className="rider3d";canvas.setAttribute("aria-hidden","true");
      renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:"low-power"});
    }catch(_){failed=true;renderer=null;canvas=null;return false;}
    renderer.setPixelRatio(1);renderer.setSize(BUF,BUF,false);
    renderer.outputEncoding=THREE.sRGBEncoding;renderer.toneMapping=THREE.NoToneMapping;
    scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(30,1,0.1,60);
    hemi=new THREE.HemisphereLight(0xffffff,0xc9d2e6,0.75);sun=new THREE.DirectionalLight(0xffffff,0.85);sun.position.set(-2,5,3);
    scene.add(hemi,sun);
    // a soft shadow and, at night, the headlight's pool of light; both turn with the rider
    ground=new THREE.Group();scene.add(ground);
    const blob=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial({map:blobTexture(),transparent:true,depthWrite:false}));
    blob.rotation.x=-Math.PI/2;blob.scale.set(1.9,0.85,1);blob.position.set(-0.05,0.005,0);ground.add(blob);
    const shape=new THREE.Shape();shape.moveTo(0,0);shape.lineTo(1.6,0.55);shape.quadraticCurveTo(1.75,0,1.6,-0.55);shape.lineTo(0,0);
    beam=new THREE.Mesh(new THREE.ShapeGeometry(shape,12),new THREE.MeshBasicMaterial({color:0xFFE9A6,transparent:true,opacity:0.34,blending:THREE.AdditiveBlending,depthWrite:false}));
    beam.rotation.x=-Math.PI/2;beam.position.set(0.6,0.01,0);ground.add(beam);
    canvas.addEventListener("webglcontextlost",e=>{e.preventDefault();failed=true;detach();});
    return true;
  }
  function avatar(id,pose){
    const preset=AV.PRESETS.find(p=>p.id===id)||AV.PRESETS.find(p=>p.id==="blue");
    const key=preset.id+":"+pose;
    if(key===currentKey)return current;
    if(current)scene.remove(current.rider);
    current=cache[key]||(cache[key]=AV.build(preset,pose));
    scene.add(current.rider);currentKey=key;
    return current;
  }
  function hide(){if(canvas)canvas.style.display="none";}
  function frame(now){
    raf=0;
    const card=document.getElementById("tracking-map-card");
    if(!card||!provider||failed){detach();return;}
    if(canvas.parentNode!==card){card.appendChild(canvas);look.rel=null;}
    card.classList.add("has-3d");
    raf=requestAnimationFrame(frame);
    if(now-lastFrame<33)return;                                   // about 30 frames a second is plenty
    const dt=Math.min(0.1,lastFrame?(now-lastFrame)/1000:0.033);lastFrame=now;
    const d=provider();
    if(!d){hide();return;}
    const anchor=card.querySelector(".map-pin.rider");
    if(!anchor||anchor.style.display==="none"){hide();return;}
    const ar=anchor.getBoundingClientRect(),cr=card.getBoundingClientRect(),size=d.size||110;
    // Screen distances are divided by the card's own scale, so the scooter
    // lands on its pin even when the card is drawn smaller than its layout size.
    const scale=card.offsetWidth?cr.width/card.offsetWidth:1,k=scale>0.05?1/scale:1;
    canvas.style.display="";canvas.style.width=size+"px";canvas.style.height=size+"px";
    canvas.style.transform="translate3d("+((ar.left+ar.width/2-cr.left)*k-size/2).toFixed(1)+"px,"+((ar.top+ar.height/2-cr.top)*k-size*0.66).toFixed(1)+"px,0)";
    canvas.style.opacity="1";
    const a=avatar(d.avatar,d.pose||"ride");
    // direction on screen, eased along the shorter way round
    const target=(((d.heading-d.bearing)%360)+360)%360;
    if(look.rel==null)look.rel=target;
    const diff=((target-look.rel+540)%360)-180,step=diff*Math.min(1,dt*4);
    look.rel=(look.rel+step+360)%360;
    // lean into the turn while it is happening
    const leanTarget=d.pose==="ride"?Math.max(-0.22,Math.min(0.22,(step/dt)*0.0035)):0;
    look.lean+=(leanTarget-look.lean)*Math.min(1,dt*6);
    const yaw=Math.PI/2-look.rel*Math.PI/180;
    a.rider.rotation.y=yaw;ground.rotation.y=yaw;a.lean.rotation.x=look.lean;
    if(d.moving)a.wheels.forEach(w=>{w.rotation.z-=dt*12;});
    a.tick(now/1000);
    beam.visible=!!d.night;hemi.intensity=d.night?0.55:0.75;sun.intensity=d.night?0.45:0.85;
    const el=(d.elevation||50)*Math.PI/180,dist=4.5;
    camera.position.set(0,Math.sin(el)*dist+0.55,Math.cos(el)*dist);camera.lookAt(0,0.55,0);
    renderer.render(scene,camera);
  }
  function attach(fn){
    provider=fn;
    if(!init())return false;
    if(!raf)raf=requestAnimationFrame(frame);
    return true;
  }
  function detach(){
    if(raf)cancelAnimationFrame(raf);raf=0;lastFrame=0;provider=null;
    if(canvas&&canvas.parentNode){canvas.parentNode.classList.remove("has-3d");canvas.parentNode.removeChild(canvas);}
  }
  return {attach,detach,available:()=>!failed};
})();

// The home screen's daily rider mascot: one persistent canvas that is moved
// into the hero after every render (so the 3D scene is built once), riding in
// place with its wheels turning. Tapping it makes it hop.
window.HeroRider=(function(){
  if(!window.THREE||!window.AV)return null;
  let renderer=null,scene=null,camera=null,canvas=null,current=null,currentId="",raf=0,last=0,hopAt=0,failed=false,night=false,slotEl=null,placed="";
  const cache={};
  function init(){
    if(renderer)return true;if(failed)return false;
    // The canvas floats on the page over its slot instead of living inside
    // the sky header: some Android WebViews stop compositing a WebGL canvas
    // nested in that header, while a page-level layer always draws.
    try{canvas=document.createElement("canvas");canvas.className="hero-rider-canvas floating";canvas.setAttribute("aria-hidden","true");
      canvas.style.cssText="position:absolute;left:0;top:0;width:1px;height:1px;pointer-events:none;z-index:6;display:none";
      renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:"low-power"});}
    catch(_){failed=true;renderer=null;return false;}
    renderer.setPixelRatio(Math.min(2,window.devicePixelRatio||1));renderer.outputEncoding=THREE.sRGBEncoding;renderer.toneMapping=THREE.NoToneMapping;
    scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(30,1,0.1,40);
    scene.add(new THREE.HemisphereLight(0xffffff,0xc9d2e6,0.78));const sun=new THREE.DirectionalLight(0xffffff,0.85);sun.position.set(2,5,3);scene.add(sun);
    canvas.addEventListener("webglcontextlost",e=>{e.preventDefault();failed=true;});
    return true;
  }
  function use(id){
    const preset=AV.PRESETS.find(p=>p.id===id)||AV.PRESETS[0];
    if(preset.id===currentId)return;
    if(current)scene.remove(current.rider);
    current=cache[preset.id]||(cache[preset.id]=AV.build(preset,"ride"));
    current.rider.rotation.y=0.05;scene.add(current.rider);currentId=preset.id;
  }
  function frame(t){
    raf=0;
    if(!canvas||!canvas.isConnected||failed)return;
    if(!slotEl||!slotEl.isConnected){canvas.style.display="none";return;}
    raf=requestAnimationFrame(frame);
    if(t-last<33)return;const dt=last?Math.min(0.1,(t-last)/1000):0.033;last=t;
    const box=slotEl.getBoundingClientRect(),w=Math.round(box.width),h=Math.round(box.height);
    if(!w||!h){canvas.style.display="none";return;}
    // Scrolled out of view: keep the loop alive but draw nothing, so the
    // phone isn't rendering 3D frames nobody can see.
    if(box.bottom<-40||box.top>window.innerHeight+40)return;
    const spot=Math.round(box.left+window.scrollX)+","+Math.round(box.top+window.scrollY)+","+w+","+h;
    if(spot!==placed){placed=spot;const [x,y]=spot.split(",");canvas.style.left=x+"px";canvas.style.top=y+"px";canvas.style.width=w+"px";canvas.style.height=h+"px";}
    if(canvas.style.display==="none")canvas.style.display="block";
    if(canvas.width!==Math.round(w*renderer.getPixelRatio())){renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();}
    const still=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;
    if(!still)current.wheels.forEach(wh=>{wh.rotation.z-=dt*10;});
    current.tick(still?0.35:t/1000);
    const since=(performance.now()-hopAt)/1000;
    current.rider.position.y=since<0.6?Math.sin(since/0.6*Math.PI)*0.35:Math.sin(t/260)*0.012;
    current.lean.rotation.x=since<0.6?Math.sin(since/0.6*Math.PI*2)*0.08:0;
    const yaw=0.95,pitch=0.16,dist=4.6;
    camera.position.set(Math.cos(yaw)*Math.cos(pitch)*dist,0.85+Math.sin(pitch)*dist,-Math.sin(yaw)*Math.cos(pitch)*dist);camera.lookAt(0,0.85,0);
    renderer.render(scene,camera);
  }
  /** Put the mascot into `slot` (an element in the freshly rendered hero). */
  function mount(slot,id){
    if(!slot||!init())return false;
    use(id);slotEl=slot;
    if(canvas.parentNode!==document.body)document.body.appendChild(canvas);
    // Draw straight away so the hero never shows an empty stage.
    if(!raf){last=0;frame(performance.now()+40);}
    return true;
  }
  function hop(){hopAt=performance.now();}
  // Still pictures of a rider (sticker book, share card, order-placed moment),
  // drawn by a second small renderer so the live mascot keeps running.
  let shotRenderer=null,shotScene=null,shotCamera=null;const shotCache={};
  function snapshot(id,w,h,sticker,pose){
    try{
      if(!shotRenderer){shotRenderer=new THREE.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true,powerPreference:"low-power"});
        shotRenderer.outputEncoding=THREE.sRGBEncoding;shotRenderer.toneMapping=THREE.NoToneMapping;shotRenderer.setPixelRatio(1);
        shotScene=new THREE.Scene();shotCamera=new THREE.PerspectiveCamera(30,1,0.1,40);
        shotScene.add(new THREE.HemisphereLight(0xffffff,0xc9d2e6,0.78));const sun=new THREE.DirectionalLight(0xffffff,0.85);sun.position.set(2,5,3);shotScene.add(sun);}
      const preset=AV.PRESETS.find(p=>p.id===id)||AV.PRESETS[0],key=preset.id+":"+(pose||"park");
      const built=shotCache[key]||(shotCache[key]=AV.build(preset,pose||"park"));
      built.tick(0.4);shotScene.add(built.rider);
      shotRenderer.setSize(w,h,false);shotCamera.aspect=w/h;shotCamera.updateProjectionMatrix();
      const yaw=sticker?0.55:0.75,pitch=sticker?0.12:0.18,dist=sticker?4.2:4.8;
      shotCamera.position.set(Math.cos(yaw)*Math.cos(pitch)*dist,0.85+Math.sin(pitch)*dist,-Math.sin(yaw)*Math.cos(pitch)*dist);shotCamera.lookAt(0,0.8,0);
      shotRenderer.render(shotScene,shotCamera);shotScene.remove(built.rider);
      const out=document.createElement("canvas");out.width=w;out.height=h;out.getContext("2d").drawImage(shotRenderer.domElement,0,0);
      return out;
    }catch(_){return null;}
  }
  function debugState(){return{current:!!current,currentId,raf,last,now:performance.now(),children:scene?scene.children.length:-1,cam:camera?camera.position.toArray().map(v=>+v.toFixed(2)):null,size:renderer?[renderer.domElement.width,renderer.domElement.height]:null,failed};}
  return {mount,hop,snapshot,available:()=>!failed,debugState};
})();
