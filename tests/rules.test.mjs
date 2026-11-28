import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initializeTestEnvironment,assertSucceeds,assertFails} from '@firebase/rules-unit-testing';
import {ref,set,update,get} from 'firebase/database';
// NEVER run against a production database. The CLI supplies an emulator address.
if(!process.env.FIREBASE_DATABASE_EMULATOR_HOST)throw Error('Start the RTDB emulator first');
const env=await initializeTestEnvironment({projectId:'demo-cadenza',database:{rules:readFileSync(new URL('../database.rules.json',import.meta.url),'utf8')}});
const db=uid=>env.authenticatedContext(uid,{email_verified:true}).database();
const legacyAbs={id:'una-old',startDate:'2027-01-01',endDate:'2027-01-05',reason:'Examen'};
const legacy={ensembles:{'ens-a':{id:'ens-a',name:'Quatuor',members:{'mbr-a':{id:'mbr-a',name:'Alice',instrument:'Violon',unavailabilities:{'una-old':legacyAbs}},'mbr-x':{id:'mbr-x',name:'X',instrument:'Alto'}},polls:{'pol-a':{id:'pol-a',date:'2027-02-01',votes:{'mbr-a':'yes'}}},rehearsals:{'reh-a':{id:'reh-a',date:'2027-02-01'}}},'ens-b':{id:'ens-b',name:'Duo',members:{'mbr-b':{id:'mbr-b',name:'Alice',instrument:'Violon'}}}},admin_users:{admin:true},admin_config:{secret_pin:'test'}};
const claim=(uid,ens,mid,rev,abs={})=>({[`accounts/${uid}/revision`]:rev,[`accounts/${uid}/memberships/${ens}`]:mid,[`profileOwners/${ens}/${mid}`]:uid,...Object.fromEntries(Object.entries(abs).map(([id,a])=>[`accounts/${uid}/absences/${id}`,a])),[`ensembles/${ens}/members/${mid}/unavailabilities`]:Object.keys(abs).length?abs:null});
test('auth, historical profile recovery, global absences and permission boundaries',async()=>{try{
 await env.clearDatabase();await env.withSecurityRulesDisabled(c=>set(ref(c.database()),legacy));
 await assertFails(get(ref(env.unauthenticatedContext().database(),'ensembles/ens-a')));
 await assertFails(get(ref(env.authenticatedContext('unverified',{email_verified:false}).database(),'ensembles/ens-a')));
 await assertFails(get(ref(db('alice'),'ensembles')));
 await assertSucceeds(get(ref(db('alice'),'ensembles/ens-a'))); // code-based trusted recovery
 await assertFails(set(ref(db('alice'),'ensembles/ens-a/name'),'intrusion'));
 await assertSucceeds(update(ref(db('alice')),claim('alice','ens-a','mbr-a',1,{'una-old':legacyAbs})));
 assert.equal((await get(ref(db('alice'),'ensembles/ens-a/polls/pol-a/votes/mbr-a'))).val(),'yes');
 assert.equal((await get(ref(db('alice'),'ensembles/ens-a/rehearsals/reh-a/id'))).val(),'reh-a');
 await assertFails(update(ref(db('bob')),claim('bob','ens-a','mbr-a',1)));
 await assertFails(get(ref(db('bob'),'accounts/alice')));
 await assertFails(set(ref(db('bob'),'profileOwners/ens-a/mbr-a'),'bob'));
 await assertFails(set(ref(db('alice'),'profileOwners/ens-a/mbr-a'),null));
 await assertSucceeds(update(ref(db('alice')),claim('alice','ens-b','mbr-b',2,{'una-old':legacyAbs})));
 const newAbs={id:'una-new',startDate:'2027-02-01',endDate:'2027-02-05',reason:'Tournee'};
 const writes={'accounts/alice/revision':3,'accounts/alice/absences/una-new':newAbs,'ensembles/ens-a/members/mbr-a/unavailabilities/una-new':newAbs,'ensembles/ens-b/members/mbr-b/unavailabilities/una-new':newAbs};
 await assertSucceeds(update(ref(db('alice')),writes));await assertFails(update(ref(db('alice')),writes));
 await assertSucceeds(update(ref(db('alice')),{'accounts/alice/revision':4,'accounts/alice/absences/una-new':null,'ensembles/ens-a/members/mbr-a/unavailabilities/una-new':null,'ensembles/ens-b/members/mbr-b/unavailabilities/una-new':null}));
 await assertFails(set(ref(db('bob'),'ensembles/ens-a/polls/pol-a/votes/mbr-a'),'no'));
 await assertSucceeds(set(ref(db('alice'),'ensembles/ens-a/polls/pol-a/votes/mbr-a'),'maybe'));
 await assertSucceeds(get(ref(db('admin'),'ensembles')));
 await assertFails(get(ref(db('alice'),'app_feedback')));
 await assertSucceeds(set(ref(db('alice'),'app_feedback/campaign/responses/alice'),{voterId:'alice',comment:'ok'}));
 await assertFails(set(ref(db('bob'),'app_feedback/campaign/responses/alice'),{voterId:'alice',comment:'bad'}));
 // Fresh ensemble: atomic create+link; fresh member join requires own ownership index.
 await assertSucceeds(update(ref(db('charlie')),{'accounts/charlie/revision':1,'accounts/charlie/memberships/ens-c':'mbr-c','profileOwners/ens-c/mbr-c':'charlie','ensembles/ens-c':{id:'ens-c',name:'Trio',members:{'mbr-c':{id:'mbr-c',name:'Charlie',instrument:'Cello'}}}}));
 await assertSucceeds(update(ref(db('bob')),{'accounts/bob/revision':1,'accounts/bob/memberships/ens-c':'mbr-d','profileOwners/ens-c/mbr-d':'bob','ensembles/ens-c/members/mbr-d':{id:'mbr-d',name:'Bob',instrument:'Alto'}}));
 }finally{await env.cleanup();}});
