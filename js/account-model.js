// Pure migration functions: stable historical IDs and idempotent exact duplicate handling.
export function mergeLegacyAbsences(canonical,legacy,ens,mid){
  const merged={...canonical};
  for(const [id,value] of Object.entries(legacy||{})){
    if(!value||typeof value!=='object')continue;
    const equal=u=>u.startDate===value.startDate&&u.endDate===value.endDate&&(u.reason||'')===(value.reason||'');
    if(Object.values(merged).some(equal))continue;
    let key=id;if(merged[key]){key=`legacy_${ens}_${mid}_${id}`;while(merged[key]&&!equal(merged[key]))key+='x';}
    merged[key]={...value,id:key};
  }return merged;
}
export function absenceWrites(uid,links,changes){
  const writes={};for(const [id,value] of Object.entries(changes)){
    writes[`accounts/${uid}/absences/${id}`]=value;
    for(const [ens,mid] of Object.entries(links))writes[`ensembles/${ens}/members/${mid}/unavailabilities/${id}`]=value;
  }return writes;
}
