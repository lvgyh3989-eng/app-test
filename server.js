const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_IN_RENDER";
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname,"public")));

async function db(q,p=[]){ if(!pool) throw new Error("DATABASE_URL manquante"); return pool.query(q,p); }

async function initDb(){
  if(!pool) return;
  await db(`
  CREATE TABLE IF NOT EXISTS users(
    id SERIAL PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS profiles(
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    name TEXT DEFAULT 'Moi', age INTEGER NOT NULL CHECK(age>=16 AND age<=100),
    sex TEXT NOT NULL DEFAULT 'male', height_cm NUMERIC NOT NULL, weight_kg NUMERIC NOT NULL,
    activity NUMERIC NOT NULL DEFAULT 1.375, goal TEXT NOT NULL DEFAULT 'mass',
    days_per_week INTEGER NOT NULL DEFAULT 3, updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS foods(
    id SERIAL PRIMARY KEY,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,quantity TEXT DEFAULT '',calories NUMERIC DEFAULT 0,
    protein NUMERIC DEFAULT 0,carbs NUMERIC DEFAULT 0,fat NUMERIC DEFAULT 0,eaten_on DATE DEFAULT CURRENT_DATE
  );
  CREATE TABLE IF NOT EXISTS weigh_ins(
    id SERIAL PRIMARY KEY,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    weight_kg NUMERIC NOT NULL,measured_on DATE DEFAULT CURRENT_DATE
  );
  CREATE TABLE IF NOT EXISTS workouts(
    id SERIAL PRIMARY KEY,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,duration_minutes INTEGER DEFAULT 45,completed_at TIMESTAMPTZ DEFAULT NOW()
  );
  `);
}
function auth(req,res,next){
  const token=(req.headers.authorization||"").replace("Bearer ","");
  if(!token) return res.status(401).json({error:"Non connecté"});
  try{req.user=jwt.verify(token,JWT_SECRET);next()}catch{return res.status(401).json({error:"Session expirée"})}
}
function metrics(p){
  const age=+p.age,w=+p.weight_kg,h=+p.height_cm,a=+p.activity;
  if(age<18) return {minor:true,calories:null,protein:null,note:"À 16–17 ans, MassUp n'impose pas de cible calorique chiffrée : les besoins liés à la croissance varient et doivent être discutés avec un parent/tuteur et, si besoin, un professionnel de santé."};
  const bmr=p.sex==="female"?10*w+6.25*h-5*age-161:10*w+6.25*h-5*age+5;
  const tdee=Math.round(bmr*a);
  return {minor:false,bmr:Math.round(bmr),tdee,calories:p.goal==="maintain"?tdee:tdee+250,protein:Math.round(w*1.6)};
}
app.get("/api/health",(req,res)=>res.json({ok:true,db:!!pool}));
app.post("/api/auth/register",async(req,res)=>{
  try{
    const {email,password}=req.body||{};
    if(!email||!password||password.length<8)return res.status(400).json({error:"Email et mot de passe de 8 caractères minimum requis."});
    const hash=await bcrypt.hash(password,12);
    const r=await db("INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id,email",[email.toLowerCase().trim(),hash]);
    const token=jwt.sign({id:r.rows[0].id,email:r.rows[0].email},JWT_SECRET,{expiresIn:"30d"});
    res.json({token,user:r.rows[0]});
  }catch(e){res.status(400).json({error:e.code==="23505"?"Cet email existe déjà.":"Impossible de créer le compte."})}
});
app.post("/api/auth/login",async(req,res)=>{
  try{
    const r=await db("SELECT id,email,password_hash FROM users WHERE email=$1",[String(req.body.email||"").toLowerCase().trim()]);
    if(!r.rowCount||!(await bcrypt.compare(req.body.password||"",r.rows[0].password_hash)))return res.status(401).json({error:"Email ou mot de passe incorrect."});
    const token=jwt.sign({id:r.rows[0].id,email:r.rows[0].email},JWT_SECRET,{expiresIn:"30d"});
    res.json({token,user:{id:r.rows[0].id,email:r.rows[0].email}});
  }catch{res.status(500).json({error:"Base de données indisponible."})}
});
app.get("/api/me",auth,async(req,res)=>{const p=(await db("SELECT * FROM profiles WHERE user_id=$1",[req.user.id])).rows[0]||null;res.json({user:req.user,profile:p})});
app.put("/api/profile",auth,async(req,res)=>{
  const p=req.body||{},age=+p.age;
  if(age<16||age>100)return res.status(400).json({error:"MassUp est conçu pour les 16 ans et plus."});
  await db(`INSERT INTO profiles(user_id,name,age,sex,height_cm,weight_kg,activity,goal,days_per_week)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
  ON CONFLICT(user_id) DO UPDATE SET name=$2,age=$3,sex=$4,height_cm=$5,weight_kg=$6,activity=$7,goal=$8,days_per_week=$9,updated_at=NOW()`,
  [req.user.id,p.name||"Moi",age,p.sex||"male",+p.height_cm,+p.weight_kg,+p.activity||1.375,p.goal||"mass",+p.days_per_week||3]);
  await db("INSERT INTO weigh_ins(user_id,weight_kg) VALUES($1,$2)",[req.user.id,+p.weight_kg]);
  res.json({ok:true});
});
app.get("/api/dashboard",auth,async(req,res)=>{
  const p=(await db("SELECT * FROM profiles WHERE user_id=$1",[req.user.id])).rows[0]||null;
  const food=(await db("SELECT COALESCE(SUM(calories),0) calories,COALESCE(SUM(protein),0) protein,COALESCE(SUM(carbs),0) carbs,COALESCE(SUM(fat),0) fat FROM foods WHERE user_id=$1 AND eaten_on=CURRENT_DATE",[req.user.id])).rows[0];
  const foods=(await db("SELECT * FROM foods WHERE user_id=$1 AND eaten_on=CURRENT_DATE ORDER BY id DESC",[req.user.id])).rows;
  const weights=(await db("SELECT weight_kg,measured_on FROM weigh_ins WHERE user_id=$1 ORDER BY measured_on ASC,id ASC LIMIT 60",[req.user.id])).rows;
  const workouts=(await db("SELECT title,duration_minutes,completed_at FROM workouts WHERE user_id=$1 ORDER BY completed_at DESC LIMIT 20",[req.user.id])).rows;
  res.json({profile:p,metrics:p?metrics(p):null,food,foods,weights,workouts});
});
app.post("/api/foods",auth,async(req,res)=>{
  const f=req.body||{};
  await db("INSERT INTO foods(user_id,name,quantity,calories,protein,carbs,fat) VALUES($1,$2,$3,$4,$5,$6,$7)",[req.user.id,f.name||"Aliment",f.quantity||"",+f.calories||0,+f.protein||0,+f.carbs||0,+f.fat||0]);
  res.json({ok:true});
});
app.post("/api/weigh-ins",auth,async(req,res)=>{
  const v=+req.body.weight_kg;if(!v)return res.status(400).json({error:"Poids invalide"});
  await db("INSERT INTO weigh_ins(user_id,weight_kg) VALUES($1,$2)",[req.user.id,v]);
  await db("UPDATE profiles SET weight_kg=$1,updated_at=NOW() WHERE user_id=$2",[v,req.user.id]);res.json({ok:true});
});
app.post("/api/workouts",auth,async(req,res)=>{
  await db("INSERT INTO workouts(user_id,title,duration_minutes) VALUES($1,$2,$3)",[req.user.id,req.body.title||"Séance",+req.body.duration_minutes||45]);res.json({ok:true});
});
app.post("/api/coach",auth,async(req,res)=>{
  const p=(await db("SELECT * FROM profiles WHERE user_id=$1",[req.user.id])).rows[0];const m=String(req.body.message||"").toLowerCase();
  if(process.env.OPENAI_API_KEY) return res.json({reply:"IA prête côté serveur. Le branchement du fournisseur est volontairement gardé côté serveur.",mode:"provider-ready"});
  let reply="Je suis le coach MassUp. Donne-moi ton objectif, ta séance ou ce que tu as mangé et je t'aide à organiser la suite.";
  if(p&&+p.age<18){
    if(m.includes("calorie")||m.includes("kcal")) reply="À 16–17 ans, je préfère ne pas te donner une cible calorique rigide : la croissance modifie les besoins. On peut suivre la régularité des repas, la qualité alimentaire, l'énergie et l'évolution du poids avec un parent/tuteur ou un professionnel si nécessaire.";
    else if(m.includes("muscu")||m.includes("muscle")||m.includes("séance")) reply="Mode croissance : 3 séances full-body/semaine peuvent convenir à beaucoup de jeunes. Priorité à la technique, au contrôle, aux charges progressives, au sommeil et à la récupération. Pas de test de 1RM ni de charges maximales seul. La musculation bien encadrée n'est pas connue pour ralentir la croissance.";
    else if(m.includes("manger")||m.includes("repas")) reply="Construis des repas complets : source de protéines + féculent/céréales + fruits/légumes + matière grasse, avec collations si faim. Pas besoin de régime extrême.";
  } else if(m.includes("calorie")||m.includes("kcal")) reply="Pour les adultes, MassUp affiche une estimation d'entretien et un surplus modéré. Ce sont des estimations, pas une prescription médicale.";
  res.json({reply,mode:"safe-fallback"});
});
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
initDb().then(()=>app.listen(PORT,()=>console.log("MassUp V3 on",PORT))).catch(e=>{console.error(e);process.exit(1)});
