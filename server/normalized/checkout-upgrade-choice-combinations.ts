import type {BundleUnitSelectionInput} from './order-repository.js'
export interface UpgradeChoiceGroup {id:string;name:string;selectionCount:number;options:readonly {productId:string;name:string}[]}
/** Enumerate complete concrete choices, never partial default selections.
 * Unknown/oversize pools return null: do not advertise an unverified branch. */
export function upgradeChoiceCombinations(groups:readonly UpgradeChoiceGroup[],maximum=40):{selection:BundleUnitSelectionInput;label:string}[]|null{
 if(!Number.isSafeInteger(maximum)||maximum<1||maximum>100||groups.length>10)return null
 let combinations:{selection:BundleUnitSelectionInput;label:string}[]=[{selection:{groups:[]},label:''}]
 if(new Set(groups.map(group=>group.id)).size!==groups.length)return null
 for(const group of groups){
  if(!Number.isSafeInteger(group.selectionCount)||group.selectionCount<1||group.selectionCount>20||group.options.length<group.selectionCount||group.options.length>100||new Set(group.options.map(option=>option.productId)).size!==group.options.length)return null
  const choices:(readonly {productId:string;name:string}[])[]=[]
  const visit=(start:number,selected:{productId:string;name:string}[])=>{
   if(choices.length>maximum)return
   if(selected.length===group.selectionCount){choices.push(selected);return}
   for(let index=start;index<=group.options.length-(group.selectionCount-selected.length);index++){
    visit(index+1,[...selected,group.options[index]!]);if(choices.length>maximum)return
   }
  }
  visit(0,[])
  if(choices.length*combinations.length>maximum)return null
  combinations=combinations.flatMap(previous=>choices.map(selected=>({selection:{groups:[...previous.selection.groups,{groupId:group.id,productIds:selected.map(option=>option.productId)}]},label:[previous.label,group.name+'：'+selected.map(option=>option.name).join('、')].filter(Boolean).join('；')})))
 }
 return combinations
}
