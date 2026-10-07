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

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

async function db(q, params=[]) {
  if (!pool) throw new Error("DATABASE_URL manquante");
  return pool.query(q, params);
}

async function initDb() {
  if (!pool) return;
  await db(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      name TEXT DEFAULT 'Moi',
      age INTEGER NOT NULL CHECK (age >= 16 AND age <= 100),
      sex TEXT NOT NULL DEFAULT 'male',
      height_cm NUMERIC NOT NULL,
      weight_kg NUMERIC NOT NULL,
      activity NUMERIC NOT NULL DEFAULT 1.375,
      goal TEXT NOT NULL DEFAULT 'mass',
      days_per_week INTEGER NOT NULL DEFAULT 3,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS foods (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      quantity TEXT DEFAULT '',
      calories NUMERIC NOT NULL DEFAULT 0,
      protein NUMERIC NOT NULL DEFAULT 0,
      carbs NUMERIC NOT NULL DEFAULT 0,
      fat NUMERIC NOT NULL DEFAULT 0,
      eaten_on DATE DEFAULT CURRENT_DATE
    );
    CREATE TABLE IF NOT EXISTS weigh_ins (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      weight_kg NUMERIC NOT NULL,
      measured_on DATE DEFAULT CURRENT_DATE
    );
    CREATE TABLE IF NOT EXISTS workouts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      duration_minutes INTEGER DEFAULT 45,
      completed_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

function auth(req,res,next) {
  const token = (req.headers.authorization || "").replace("Bearer ","");
  if (!token) return res.status(401).json({error:"Non connecté"});
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({error:"Session expirée"}); }
}

function metrics(profile) {
  const age = Number(profile.age), w = Number(profile.weight_kg), h = Number(profile.height_cm);
  if (age < 18) return { minor:true, calories:null, protein:null };
  const bmr = profile.sex === "female" ? 10*w + 6.25*h - 5*age - 161 : 10*w + 6.25*h - 5*age + 5;
  const tdee = Math.round(bmr * Number(profile.activity));
  const calories = profile.goal === "maintain" ? tdee : tdee + 250;
  return { minor:false, bmr:Math.round(bmr), tdee, calories, protein:Math.round(w*1.6) };
}

app.post("/api/auth/register", async (req,res)=>{
  try {
    const {email,password} = req.body || {};
    if (!email || !password || password.length < 8) return res.status(400).json({error:"Email et mot de passe de 8 caractères minimum requis."});
    const hash = await bcrypt.hash(password, 12);
    const r = await db("INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id,email",[email.toLowerCase().trim(),hash]);
    const token = jwt.sign({id:r.rows[0].id,email:r.rows[0].email},JWT_SECRET,{expiresIn:"30d"});
    res.json({token,user:r.rows[0]});
  } catch(e) { res.status(400).json({error:e.code==="23505"?"Cet email existe déjà.":"Impossible de créer le compte."}); }
});

app.post("/api/auth/login", async (req,res)=>{
  try {
    const {email,password} = req.body || {};
    const r=await db("SELECT id,email,password_hash FROM users WHERE email=$1",[String(email||"").toLowerCase().trim()]);
    if (!r.rowCount || !(await bcrypt.compare(password||"",r.rows[0].password_hash))) return res.status(401).json({error:"Email ou mot de passe incorrect."});
    const token=jwt.sign({id:r.rows[0].id,email:r.rows[0].email},JWT_SECRET,{expiresIn:"30d"});
    res.json({token,user:{id:r.rows[0].id,email:r.rows[0].email}});
  } catch(e) { res.status(500).json({error:"Base de données indisponible."}); }
});

app.get("/api/me",auth,async(req,res)=>{
  const p=await db("SELECT * FROM profiles WHERE user_id=$1",[req.user.id]);
  res.json({user:req.user,profile:p.rows[0]||null});
});

app.put("/api/profile",auth,async(req,res)=>{
  const p=req.body||{}, age=Number(p.age);
  if(age<16 || age>100) return res.status(400).json({error:"MassUp est actuellement conçu pour les 16 ans et plus."});
  await db(`INSERT INTO profiles(user_id,name,age,sex,height_cm,weight_kg,activity,goal,days_per_week)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(user_id) DO UPDATE SET name=$2,age=$3,sex=$4,height_cm=$5,weight_kg=$6,activity=$7,goal=$8,days_per_week=$9,updated_at=NOW()`,
    [req.user.id,p.name||"Moi",age,p.sex||"male",Number(p.height_cm),Number(p.weight_kg),Number(p.activity||1.375),p.goal||"mass",Number(p.days_per_week||3)]);
  await db("INSERT INTO weigh_ins(user_id,weight_kg) VALUES($1,$2)",[req.user.id,Number(p.weight_kg)]);
  res.json({ok:true});
});

app.get("/api/dashboard",auth,async(req,res)=>{
  const p=(await db("SELECT * FROM profiles WHERE user_id=$1",[req.user.id])).rows[0]||null;
  const food=(await db("SELECT COALESCE(SUM(calories),0) calories,COALESCE(SUM(protein),0) protein,COALESCE(SUM(carbs),0) carbs,COALESCE(SUM(fat),0) fat FROM foods WHERE user_id=$1 AND eaten_on=CURRENT_DATE",[req.user.id])).rows[0];
  const foods=(await db("SELECT * FROM foods WHERE user_id=$1 AND eaten_on=CURRENT_DATE ORDER BY id DESC",[req.user.id])).rows;
  const weights=(await db("SELECT weight_kg,measured_on FROM weigh_ins WHERE user_id=$1 ORDER BY measured_on ASC,id ASC LIMIT 30",[req.user.id])).rows;
  const workouts=(await db("SELECT title,duration_minutes,completed_at FROM workouts WHERE user_id=$1 ORDER BY completed_at DESC LIMIT 10",[req.user.id])).rows;
  res.json({profile:p,metrics:p?metrics(p):null,food,foods,weights,workouts});
});

app.post("/api/foods",auth,async(req,res)=>{
  const f=req.body||{};
  await db("INSERT INTO foods(user_id,name,quantity,calories,protein,carbs,fat) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [req.user.id,f.name||"Aliment",f.quantity||"",Number(f.calories||0),Number(f.protein||0),Number(f.carbs||0),Number(f.fat||0)]);
  res.json({ok:true});
});

app.post("/api/weigh-ins",auth,async(req,res)=>{
  const v=Number(req.body.weight_kg);
  if(!v) return res.status(400).json({error:"Poids invalide"});
  await db("INSERT INTO weigh_ins(user_id,weight_kg) VALUES($1,$2)",[req.user.id,v]);
  await db("UPDATE profiles SET weight_kg=$1,updated_at=NOW() WHERE user_id=$2",[v,req.user.id]);
  res.json({ok:true});
});

app.post("/api/workouts",auth,async(req,res)=>{
  await db("INSERT INTO workouts(user_id,title,duration_minutes) VALUES($1,$2,$3)",[req.user.id,req.body.title||"Séance",Number(req.body.duration_minutes||45)]);
  res.json({ok:true});
});

app.post("/api/coach",auth,async(req,res)=>{
  const message=String(req.body.message||"").trim();
  const p=(await db("SELECT * FROM profiles WHERE user_id=$1",[req.user.id])).rows[0];
  if(!message) return res.status(400).json({error:"Message vide"});
  const minor=p && Number(p.age)<18;
  if (!process.env.OPENAI_API_KEY) {
    let reply="Je suis le coach MassUp. Pour l'instant, le moteur IA réel n'est pas encore connecté. Je peux néanmoins te donner des repères généraux dans le prototype.";
    const m=message.toLowerCase();
    if(minor) reply="Tu es en mode croissance. Je peux t'aider à organiser des repas variés, une activité progressive et ton suivi, mais je ne fixe pas de surplus calorique agressif ni de poids cible. Si tu as une inquiétude sur ta croissance ou ton poids, parle-en à un professionnel de santé.";
    else if(m.includes("repas")||m.includes("manger")) reply="Pour une prise de masse progressive, vise des repas réguliers et complets : protéines + féculent + fruits/légumes + source de matières grasses. Observe la tendance de ton poids sur plusieurs semaines.";
    else if(m.includes("séance")||m.includes("sport")) reply="Progresse progressivement : bonne technique, séries contrôlées, récupération suffisante et augmentation graduelle des répétitions ou de la charge.";
    return res.json({reply,mode:"fallback"});
  }
  // Production hook: call the selected LLM provider from the server.
  // The API key remains server-side.
  res.json({reply:"Le connecteur IA est activé côté serveur. Ajoute ici l'appel au fournisseur de ton choix et conserve la clé uniquement dans Render.",mode:"provider-ready"});
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

initDb().then(()=>app.listen(PORT,()=>console.log("MassUp V2 on",PORT))).catch(e=>{console.error(e);process.exit(1)});
