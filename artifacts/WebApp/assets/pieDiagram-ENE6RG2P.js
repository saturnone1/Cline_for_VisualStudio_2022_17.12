import{p as at}from"./chunk-JWPE2WC7.js";import{aX as b,cM as B,aw as rt,bp as nt,cy as it,bq as ot,cz as st,bu as lt,cB as ct,aq as g,c7 as G,bs as ut,aJ as dt,cx as gt,ch as pt,aW as ht,aK as ft,bb as mt}from"./index.js";import{p as vt}from"./cynefin-VYW2F7L2.js";import{d as J}from"./arc.js";import{o as xt}from"./ordinal.js";import"./init.js";function yt(t,n){return n<t?-1:n>t?1:n>=t?0:NaN}function St(t){return t}function wt(){var t=St,n=yt,S=null,T=b(0),l=b(B),p=b(0);function i(e){var r,s=(e=rt(e)).length,h,w,$=0,f=new Array(s),o=new Array(s),D=+T.apply(this,arguments),M=Math.min(B,Math.max(-B,l.apply(this,arguments)-D)),k,W=Math.min(Math.abs(M)/s,p.apply(this,arguments)),u=W*(M<0?-1:1),A;for(r=0;r<s;++r)(A=o[f[r]=r]=+t(e[r],r,e))>0&&($+=A);for(n!=null?f.sort(function(E,m){return n(o[E],o[m])}):S!=null&&f.sort(function(E,m){return S(e[E],e[m])}),r=0,w=$?(M-s*u)/$:0;r<s;++r,D=k)h=f[r],A=o[h],k=D+(A>0?A*w:0)+u,o[h]={data:e[h],index:r,value:A,startAngle:D,endAngle:k,padAngle:W};return o}return i.value=function(e){return arguments.length?(t=typeof e=="function"?e:b(+e),i):t},i.sortValues=function(e){return arguments.length?(n=e,S=null,i):n},i.sort=function(e){return arguments.length?(S=e,n=null,i):S},i.startAngle=function(e){return arguments.length?(T=typeof e=="function"?e:b(+e),i):T},i.endAngle=function(e){return arguments.length?(l=typeof e=="function"?e:b(+e),i):l},i.padAngle=function(e){return arguments.length?(p=typeof e=="function"?e:b(+e),i):p},i}var At=mt.pie,I={sections:new Map,showData:!1},H=I.sections,V=I.showData,Ct=structuredClone(At),$t=g(()=>structuredClone(Ct),"getConfig"),Dt=g(()=>{H=new Map,V=I.showData,ft()},"clear"),bt=g(({label:t,value:n})=>{if(n<0)throw new Error(`"${t}" has invalid value: ${n}. Negative values are not allowed in pie charts. All slice values must be >= 0.`);H.has(t)||(H.set(t,n),G.debug(`added new section: ${t}, with value: ${n}`))},"addSection"),Tt=g(()=>H,"getSections"),kt=g(t=>{V=t},"setShowData"),zt=g(()=>V,"getShowData"),K={getConfig:$t,clear:Dt,setDiagramTitle:ct,getDiagramTitle:lt,setAccTitle:st,getAccTitle:ot,setAccDescription:it,getAccDescription:nt,addSection:bt,getSections:Tt,setShowData:kt,getShowData:zt},Mt=g((t,n)=>{at(t,n),n.setShowData(t.showData),t.sections.map(n.addSection)},"populateDb"),Et={parse:g(async t=>{const n=await vt("pie",t);G.debug(n),Mt(n,K)},"parse")},Rt=g(t=>`
  .pieCircle{
    stroke: ${t.pieStrokeColor};
    stroke-width : ${t.pieStrokeWidth};
    opacity : ${t.pieOpacity};
  }
  .pieCircle.highlighted{
    scale: 1.05;
    opacity: 1;
  }
  .pieCircle.highlightedOnHover:hover{
    transition-duration: 250ms;
    scale: 1.05;
    opacity: 1;
  }
  .pieOuterCircle{
    stroke: ${t.pieOuterStrokeColor};
    stroke-width: ${t.pieOuterStrokeWidth};
    fill: none;
  }
  .pieTitleText {
    text-anchor: middle;
    font-size: ${t.pieTitleTextSize};
    fill: ${t.pieTitleTextColor};
    font-family: ${t.fontFamily};
  }
  .slice {
    font-family: ${t.fontFamily};
    fill: ${t.pieSectionTextColor};
    font-size:${t.pieSectionTextSize};
    // fill: white;
  }
  .legend text {
    fill: ${t.pieLegendTextColor};
    font-family: ${t.fontFamily};
    font-size: ${t.pieLegendTextSize};
  }
`,"getStyles"),Wt=Rt,Lt=g(t=>{const n=[...t.values()].reduce((l,p)=>l+p,0),S=[...t.entries()].map(([l,p])=>({label:l,value:p})).filter(l=>l.value/n*100>=1);return wt().value(l=>l.value).sort(null)(S)},"createPieArcs"),Ft=g((t,n,S,T)=>{G.debug(`rendering pie chart
`+t);const l=T.db,p=ut(),i=dt(l.getConfig(),p.pie),e=40,r=18,s=4,h=450,w=h,$=gt(n),f=$.append("g");f.attr("transform","translate("+w/2+","+h/2+")");const{themeVariables:o}=p;let[D]=pt(o.pieOuterStrokeWidth);D??=2;const M=i.legendPosition,k=i.textPosition,W=i.donutHole>0&&i.donutHole<=.9?i.donutHole:0,u=Math.min(w,h)/2-e,A=J().innerRadius(W*u).outerRadius(u),E=J().innerRadius(u*k).outerRadius(u*k),m=f.append("g");m.append("circle").attr("cx",0).attr("cy",0).attr("r",u+D/2).attr("class","pieOuterCircle");const L=l.getSections(),Z=Lt(L),Q=[o.pie1,o.pie2,o.pie3,o.pie4,o.pie5,o.pie6,o.pie7,o.pie8,o.pie9,o.pie10,o.pie11,o.pie12];let N=0;L.forEach(a=>{N+=a});const q=Z.filter(a=>(a.data.value/N*100).toFixed(0)!=="0"),O=xt(Q).domain([...L.keys()]);m.selectAll("mySlices").data(q).enter().append("path").attr("d",A).attr("fill",a=>O(a.data.label)).attr("class",a=>{let c="pieCircle";return i.highlightSlice==="hover"?c+=" highlightedOnHover":i.highlightSlice===a.data.label&&(c+=" highlighted"),c}),m.selectAll("mySlices").data(q).enter().append("text").text(a=>(a.data.value/N*100).toFixed(0)+"%").attr("transform",a=>"translate("+E.centroid(a)+")").style("text-anchor","middle").attr("class","slice");const Y=f.append("text").text(l.getDiagramTitle()).attr("x",0).attr("y",-400/2).attr("class","pieTitleText"),R=[...L.entries()].map(([a,c])=>({label:a,value:c})),C=f.selectAll(".legend").data(R).enter().append("g").attr("class","legend");C.append("rect").attr("width",r).attr("height",r).style("fill",a=>O(a.label)).style("stroke",a=>O(a.label)),C.append("text").attr("x",r+s).attr("y",r-s).text(a=>l.getShowData()?`${a.label} [${a.value}]`:a.label);const z=Math.max(...C.selectAll("text").nodes().map(a=>a?.getBoundingClientRect().width??0));let F=h,P=w+e;const d=r+s,_=R.length*d;switch(M){case"center":C.attr("transform",(a,c)=>{const v=d*R.length/2,x=-z/2-(r+s),y=c*d-v;return"translate("+x+","+y+")"});break;case"top":F+=_,C.attr("transform",(a,c)=>{const v=u,x=-z/2-(r+s),y=c*d-v;return`translate(${x}, ${y})`}),m.attr("transform",()=>`translate(0, ${_+d})`);break;case"bottom":F+=_,C.attr("transform",(a,c)=>{const v=-u-d,x=-z/2-(r+s),y=c*d-v;return"translate("+x+","+y+")"});break;case"left":P+=r+s+z,C.attr("transform",(a,c)=>{const v=d*R.length/2,x=-u-(r+s),y=c*d-v;return"translate("+x+","+y+")"}),m.attr("transform",()=>`translate(${z+r+s}, 0)`);break;default:P+=r+s+z,C.attr("transform",(a,c)=>{const v=d*R.length/2,x=12*r,y=c*d-v;return"translate("+x+","+y+")"});break}const U=Y.node()?.getBoundingClientRect().width??0,tt=w/2-U/2,et=w/2+U/2,X=Math.min(0,tt),j=Math.max(P,et)-X;$.attr("viewBox",`${X} 0 ${j} ${F}`),ht($,F,j,i.useMaxWidth)},"draw"),Ht={draw:Ft},Vt={parser:Et,db:K,renderer:Ht,styles:Wt};export{Vt as diagram};
