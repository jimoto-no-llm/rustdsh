// Minimal bounded protobuf wire codec; only schema-verified fields are projected.
export function varint(value) {
  let n=BigInt(value);if(n<0n)throw Error('Negative protobuf varint');const out=[];
  do{let byte=Number(n&127n);n>>=7n;if(n)byte|=128;out.push(byte);}while(n);
  return Buffer.from(out);
}
export function pbString(field,value) {return pbBytes(field,Buffer.from(String(value)));}
export function pbBytes(field,value) {return Buffer.concat([varint(field*8+2),varint(value.length),value]);}
export function pbInt(field,value) {return Buffer.concat([varint(field*8),varint(value)]);}
export function pbFields(...values) {return Buffer.concat(values.filter(Boolean));}
export function decodeFields(input) {
  const bytes=Buffer.from(input);if(bytes.length>4*1024*1024)throw Error('Protobuf size limit');let offset=0;const out=new Map();
  function readVarint(){let n=0n;for(let i=0;i<10;i++){if(offset>=bytes.length)throw Error('Truncated protobuf varint');const b=bytes[offset++];n|=BigInt(b&127)<<BigInt(i*7);if(!(b&128))return n;}throw Error('Invalid protobuf varint');}
  while(offset<bytes.length){const tag=Number(readVarint()),field=tag>>>3,type=tag&7;let value;
    if(!field)throw Error('Invalid protobuf field');
    if(type===0)value=readVarint();
    else if(type===2){const size=Number(readVarint());if(size<0||size>bytes.length-offset)throw Error('Truncated protobuf bytes');value=bytes.subarray(offset,offset+size);offset+=size;}
    else if(type===1||type===5){const size=type===1?8:4;if(offset+size>bytes.length)throw Error('Truncated protobuf fixed field');value=bytes.subarray(offset,offset+size);offset+=size;}
    else throw Error('Unsupported protobuf wire type');
    const list=out.get(field)??[];list.push(value);out.set(field,list);
  }return out;
}
export function pbText(fields,field) {const value=fields.get(field)?.[0];return Buffer.isBuffer(value)?value.toString('utf8'):undefined;}
