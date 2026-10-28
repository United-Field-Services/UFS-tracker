'use strict';
const fs=require('node:fs');const path=require('node:path');const {execFileSync}=require('node:child_process');
for(const folder of ['src','renderer','scripts'])for(const name of fs.readdirSync(path.join(__dirname,'..',folder)))if(/\.(cjs|js)$/.test(name))execFileSync(process.execPath,['--check',path.join(__dirname,'..',folder,name)],{stdio:'inherit'});
