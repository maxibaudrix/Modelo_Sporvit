/**
 * generatePlanV4.js — Sporvit Plan Engine
 *
 * Cambios respecto a v3:
 *
 * ── BUGS RESUELTOS ──────────────────────────────────────────
 *  [FIX-1] Ejercicios vacíos: usedSlugs ahora es POR SESIÓN,
 *          no global semanal. Evitar repetición dentro de la semana
 *          se hace con un Set separado (weeklyUsedSlugs) que solo
 *          bloquea el mismo ejercicio dos veces, no agota el pool.
 *
 *  [FIX-2] Recetas con 0 calorías: filterRecipes ahora exige
 *          calories > 0 y protein_g > 0.
 *
 *  [FIX-3] trainingTypes no debe filtrar ejercicios individuales.
 *          Un usuario con ["cardio","strength"] quiere sesiones de
 *          ese tipo, pero los ejercicios se filtran por difficulty
 *          y equipment, no por el tipo de sesión.
 *
 *  [FIX-4] glutes mapeado dentro de legs en el split engine.
 *
 *  [FIX-5] Recetas sin name o sin slug: fallbacks añadidos.
 *
 * ── MEJORAS DE CALIDAD ───────────────────────────────────────
 *  [Q-1]  Timing nutricional: la comida pre-entrenamiento es alta
 *         en carbos y moderada en proteína; la post es alta en
 *         proteína y carbos, baja en grasa. Requiere approximatedWorkoutHour
 *         en el perfil (opcional, default 18:00).
 *
 *  [Q-2]  Macros diferenciados por día: días de entrenamiento
 *         suben carbos +20% y bajan grasa -15%; días de descanso
 *         al revés. Proteína constante siempre.
 *
 *  [Q-3]  Orden de ejercicios dentro de la sesión:
 *         compound → compound_accessory → isolation → core.
 *         Requiere campo `category` en ejercicios; si no existe,
 *         se infiere por muscleGroup.
 *
 *  [Q-4]  Progresión semanal (weekNumber como input):
 *         - Semana 1-3: base (sets/reps base)
 *         - Semana 2: +1 rep por set
 *         - Semana 3: +1 set por ejercicio
 *         - Semana 4: deload (−40% volumen, intensidad "low")
 *         El ciclo se repite cada 4 semanas.
 *
 *  [Q-5]  Warmup y cooldown específicos por splitFocus.
 *
 *  [Q-6]  RPE recomendado por sesión según intensity del perfil.
 *
 *  [Q-7]  portionMultiplier en cada receta: ratio entre las calorías
 *         target del slot y las calorías reales de la receta.
 *         El frontend puede usarlo para escalar cantidades.
 *
 *  [Q-8]  Proteína mínima por slot verificada: si la receta no
 *         aporta al menos el 60% del target proteico del slot,
 *         se penaliza en el ranking.
 *
 *  [Q-9]  48h de recuperación entre grupos musculares: el motor
 *         registra qué grupos se trabajaron cada día y los excluye
 *         o penaliza si no han pasado 48h.
 *
 * Uso:
 *   node generatePlanV4.js
 *   node generatePlanV4.js --week 3   ← genera semana 3 del ciclo
 *
 * Requiere:
 *   ./data/exercises.json
 *   ./data/recipes.json
 */

import fs   from "fs";
import path from "path";
import { randomUUID } from "crypto";

// ─────────────────────────────────────────────
// CONFIGURACIÓN GLOBAL
// ─────────────────────────────────────────────

const VERSION = "v4";

// Número de semana inyectable por CLI (--week N)
const weekArg = process.argv.indexOf("--week");
const WEEK_NUMBER = weekArg !== -1 ? parseInt(process.argv[weekArg + 1], 10) : 1;

// ─────────────────────────────────────────────
// PERFILES (del onboarding)
// ─────────────────────────────────────────────

const profiles = [
  {
    userId: "user_cut_001",
    age: 34,
    gender: "MALE",
    weightKg: 82,
    heightCm: 178,
    bodyFatPercentage: null,

    goal: "LOSE",
    goalNormalized: "cut",
    targetTimeline: 12,
    targetWeight: 75,

    activityLevel: "MODERATELY_ACTIVE",
    workType: "DESK",
    sittingHours: "6H_8H",
    availableDays: ["monday", "wednesday", "friday", "saturday"],

    experienceLevel: "Intermediate",
    trainingFrequency: "3_4",
    trainingTypes: ["strength"],
    sessionDuration: 50,
    intensity: "moderate",

    // [Q-1] Hora aproximada de entrenamiento (formato 24h, opcional)
    approximateWorkoutHour: 19,

    dietType: "standard",
    allergies: [],
    excludedIngredients: [],
    mealsPerDay: 4,

    calculations: {
      bmr: 1834,
      tdee: 2450,
      targetCalories: 2083,
      trainingDayCalories: 2283,
      restDayCalories: 1883,
      macros: {
        protein: 164,
        carbs: 155,
        fat: 69
      }
    },

    startDate: "2025-12-29"
  },

  {
    userId: "user_endurance_002",
    age: 41,
    gender: "FEMALE",
    weightKg: 64,
    heightCm: 167,
    bodyFatPercentage: null,

    goal: "MAINTAIN",
    goalNormalized: "endurance",
    targetTimeline: 8,
    targetWeight: null,

    activityLevel: "LIGHTLY_ACTIVE",
    workType: "MIXED",
    sittingHours: "4H_6H",
    availableDays: ["tuesday", "thursday", "sunday"],

    experienceLevel: "Beginner",
    trainingFrequency: "3_4",
    trainingTypes: ["cardio", "strength"],  // tipo de SESIÓN, no filtro de ejercicios
    sessionDuration: 40,
    intensity: "low",

    approximateWorkoutHour: 18,

    dietType: "standard",
    allergies: [],
    excludedIngredients: [],
    mealsPerDay: 3,

    calculations: {
      bmr: 1394,
      tdee: 1830,
      targetCalories: 1830,
      trainingDayCalories: 2030,
      restDayCalories: 1630,
      macros: {
        protein: 128,
        carbs: 183,
        fat: 61
      }
    },

    startDate: "2026-01-05"
  }
];

// ─────────────────────────────────────────────
// [Q-4] PROGRESIÓN SEMANAL
// ─────────────────────────────────────────────

/**
 * Devuelve los modificadores de volumen e intensidad para la semana actual.
 * El ciclo es de 4 semanas: base → volumen → intensidad → deload.
 */
function getWeeklyProgression(weekNumber) {
  const cycleWeek = ((weekNumber - 1) % 4) + 1; // 1..4

  switch (cycleWeek) {
    case 1: // Base
      return {
        phase: "base",
        setsModifier: 0,     // sin cambio
        repsModifier: 0,
        intensityOverride: null,
        deload: false,
        label: "Base — establece la base de volumen"
      };
    case 2: // Volumen acumulado: +1 rep por set
      return {
        phase: "volume",
        setsModifier: 0,
        repsModifier: 1,
        intensityOverride: null,
        deload: false,
        label: "Volumen — +1 rep por serie"
      };
    case 3: // Intensificación: +1 set por ejercicio
      return {
        phase: "intensity",
        setsModifier: 1,
        repsModifier: 0,
        intensityOverride: null,
        deload: false,
        label: "Intensidad — +1 serie por ejercicio"
      };
    case 4: // Deload: −40% volumen, intensidad baja
      return {
        phase: "deload",
        setsModifier: -1,    // quita 1 set
        repsModifier: -2,    // quita 2 reps
        intensityOverride: "low",
        deload: true,
        label: "Deload — recuperación activa"
      };
  }
}

// ─────────────────────────────────────────────
// [Q-6] RPE POR INTENSIDAD
// ─────────────────────────────────────────────

const RPE_MAP = {
  low:      { rpe: 6, label: "Esfuerzo ligero — puedes mantener conversación" },
  moderate: { rpe: 7, label: "Esfuerzo moderado — respiración elevada pero controlada" },
  high:     { rpe: 9, label: "Esfuerzo alto — cerca del límite, pocas reps en reserva" }
};

// ─────────────────────────────────────────────
// SPLIT ENGINE — balance muscular
// ─────────────────────────────────────────────

/**
 * [FIX-4] glutes ahora vive dentro de legs en todos los splits.
 * Devuelve mapa de splitIndex → [muscleGroups permitidos]
 */
function determineSplit(trainingDays) {
  if (trainingDays <= 2) {
    return {
      0: ["chest", "back", "legs", "glutes", "shoulders", "arms", "core"],
      1: ["chest", "back", "legs", "glutes", "shoulders", "arms", "core"]
    };
  }
  if (trainingDays === 3) {
    return {
      0: ["legs", "glutes", "back", "core"],       // Inferior + Tirón
      1: ["chest", "shoulders", "arms"],            // Superior + Empuje
      2: ["legs", "glutes", "back", "chest", "core"] // Full Body
    };
  }
  if (trainingDays === 4) {
    return {
      0: ["chest", "back", "shoulders", "arms"],   // Upper A
      1: ["legs", "glutes", "core"],               // Lower A
      2: ["chest", "back", "shoulders"],           // Upper B
      3: ["legs", "glutes", "core", "arms"]        // Lower B
    };
  }
  if (trainingDays >= 5) {
    return {
      0: ["chest", "shoulders", "arms"],             // Push
      1: ["back", "arms"],                           // Pull
      2: ["legs", "glutes", "core"],                 // Legs
      3: ["chest", "back", "shoulders"],             // Upper
      4: ["legs", "glutes", "core", "chest", "back"] // Full
    };
  }
}

const SPLIT_NAMES = {
  1: ["Full Body"],
  2: ["Full Body A", "Full Body B"],
  3: ["Inferior + Tirón", "Superior + Empuje", "Full Body"],
  4: ["Upper A", "Lower A", "Upper B", "Lower B"],
  5: ["Push", "Pull", "Legs", "Upper", "Full"],
  6: ["Push", "Pull", "Legs", "Push B", "Pull B", "Legs B"]
};

function buildSessionBudget(allowedGroups, totalSlots) {
  const perGroup = Math.floor(totalSlots / allowedGroups.length);
  const remainder = totalSlots % allowedGroups.length;
  const budget = {};
  allowedGroups.forEach((g, i) => {
    budget[g] = perGroup + (i < remainder ? 1 : 0);
  });
  return budget;
}

// ─────────────────────────────────────────────
// [Q-5] WARMUP / COOLDOWN ESPECÍFICOS POR SPLIT
// ─────────────────────────────────────────────

const WARMUP_BY_SPLIT = {
  "Inferior + Tirón": {
    duration: 8,
    description: "Movilidad de cadera: círculos de cadera 2×10, sentadilla profunda asistida 2×10. Activación de glúteo: puentes de glúteo 2×15. Cardio suave 3 min (bicicleta o trote)."
  },
  "Superior + Empuje": {
    duration: 7,
    description: "Rotación de hombro (interna y externa) 2×15, movilidad torácica con foam roller 2 min, elevaciones laterales con banda 2×15. Cardio suave 3 min."
  },
  "Full Body": {
    duration: 8,
    description: "Movilidad articular completa: cuello, hombros, caderas, rodillas, tobillos (30s cada zona). Sentadilla sin peso 2×10. Cardio suave 3 min."
  },
  "Upper A": {
    duration: 7,
    description: "Rotación de hombro con banda 2×15, movilidad torácica 2 min, aperturas de pecho con banda 2×15. Cardio suave 3 min."
  },
  "Lower A": {
    duration: 8,
    description: "Activación de glúteo: clamshells 2×15, puentes 2×15. Movilidad de cadera: flexores de cadera (60s por lado). Cardio suave 3 min."
  },
  "Upper B": {
    duration: 7,
    description: "Rotación de hombro con banda 2×15, movilidad torácica 2 min, remo con banda 2×15. Cardio suave 3 min."
  },
  "Lower B": {
    duration: 8,
    description: "Activación de glúteo: monster walks con banda 2×10m. Movilidad de tobillo: círculos 2×10. Bisagra de cadera sin peso 2×10. Cardio suave 3 min."
  },
  "Push": {
    duration: 7,
    description: "Rotación interna/externa de hombro con banda 2×15. Movilidad de muñeca 1 min. Press con banda 2×15. Cardio suave 3 min."
  },
  "Pull": {
    duration: 7,
    description: "Movilidad de hombro en polea baja 2×15. Retracción escapular con banda 2×15. Movilidad torácica 2 min. Cardio suave 3 min."
  },
  "Legs": {
    duration: 8,
    description: "Puentes de glúteo 2×15, sentadilla sin peso 2×15, movilidad de tobillo 2×10. Cardio suave 3 min."
  },
  "Upper": {
    duration: 7,
    description: "Rotación de hombro con banda 2×15, aperturas de pecho 2×15, movilidad torácica 2 min. Cardio suave 3 min."
  },
  "Full Body A": {
    duration: 8,
    description: "Movilidad articular completa 3 min. Sentadilla sin peso 2×10. Rotación de hombro con banda 2×15. Cardio suave 2 min."
  },
  "Full Body B": {
    duration: 8,
    description: "Movilidad articular completa 3 min. Bisagra de cadera 2×10. Movilidad torácica 2 min. Cardio suave 2 min."
  }
};

const COOLDOWN_BY_SPLIT = {
  "Inferior + Tirón": {
    duration: 7,
    description: "Estiramiento de isquiotibiales tumbado 60s por lado. Piriforme (postura del 4) 60s por lado. Estiramiento de dorsal con banda o barra 45s. Flexores de cadera en zancada 45s por lado."
  },
  "Superior + Empuje": {
    duration: 6,
    description: "Estiramiento de pectoral en esquina 60s. Apertura de pecho en suelo 45s. Estiramiento de deltoides cruzado 45s por lado. Cuello lateral 30s por lado."
  },
  "Full Body": {
    duration: 8,
    description: "Estiramiento completo: isquiotibiales 60s, cuádriceps de pie 45s por lado, pectoral en esquina 60s, dorsal con banda 45s, glúteo (postura del 4) 60s por lado."
  },
  "Upper A": {
    duration: 6,
    description: "Estiramiento de pectoral 60s. Deltoides cruzado 45s por lado. Trapecios: inclinación lateral de cuello 30s por lado. Tríceps sobre cabeza 45s por lado."
  },
  "Lower A": {
    duration: 7,
    description: "Estiramiento de cuádriceps de pie 60s por lado. Isquiotibiales tumbado 60s por lado. Glúteo (postura del 4) 60s por lado. Flexores de cadera en zancada 45s por lado."
  },
  "Upper B": {
    duration: 6,
    description: "Estiramiento de dorsal con banda 60s. Bíceps en pared 45s por lado. Trapecios: rotación de cuello 30s por lado. Pectoral en esquina 60s."
  },
  "Lower B": {
    duration: 7,
    description: "Estiramiento de gemelos en pared 60s por lado. Isquiotibiales sentado 60s. Glúteo tumbado 60s por lado. Flexores de cadera 45s por lado."
  },
  "Push":  { duration: 6, description: "Pectoral en esquina 60s. Deltoides frontal 45s por lado. Tríceps sobre cabeza 45s por lado. Muñecas: extensión pasiva 30s." },
  "Pull":  { duration: 6, description: "Dorsal con banda 60s. Bíceps en pared 45s por lado. Romboides: estiramiento de abrazo 45s. Cuello lateral 30s por lado." },
  "Legs":  { duration: 7, description: "Cuádriceps de pie 60s por lado. Isquiotibiales tumbado 60s. Glúteo (postura del 4) 60s por lado. Gemelos en pared 45s por lado." },
  "Upper": { duration: 6, description: "Pectoral 60s. Dorsal 60s. Deltoides 45s por lado. Cuello 30s por lado." },
  "Full Body A": { duration: 8, description: "Estiramiento completo: isquiotibiales 60s, pectoral 60s, dorsal 45s, glúteo 60s por lado, cuello 30s por lado." },
  "Full Body B": { duration: 8, description: "Estiramiento completo: cuádriceps 60s por lado, dorsal 60s, pectoral 45s, isquiotibiales 60s, glúteo 60s por lado." }
};

const WARMUP_DEFAULT = {
  duration: 7,
  description: "Movilidad dinámica articular completa 3 min. Activación del core: plancha 3×20s. Cardio suave 3 min."
};
const COOLDOWN_DEFAULT = {
  duration: 6,
  description: "Estiramientos estáticos de los grupos trabajados, 60 segundos por músculo principal."
};

// ─────────────────────────────────────────────
// [Q-3] CATEGORÍAS DE EJERCICIO para ordenación
// ─────────────────────────────────────────────

/**
 * Infiere la categoría de un ejercicio si no la tiene declarada.
 * compound      → ejercicios multiarticulares principales
 * compound_acc  → compuestos secundarios / accesorios
 * isolation     → aislamiento uniarticular
 * core          → ejercicios de núcleo/estabilidad
 */
function inferExerciseCategory(ex) {
  if (ex.category) return ex.category;

  // Core siempre al final
  if (ex.muscleGroup === "core") return "core";

  // Heurística por nombre (español) para los más comunes
  const name = (ex.nameEs || ex.name || "").toLowerCase();
  const compoundKeywords = [
    "sentadilla", "peso muerto", "press", "remo", "jalón",
    "dominada", "fondos", "hip thrust", "zancada", "estocada",
    "squat", "deadlift", "bench", "row", "pulldown", "lunge"
  ];
  const isolationKeywords = [
    "curl", "extensión", "elevación", "aperturas", "patada",
    "crunch", "concentración", "predicador", "patada trasera"
  ];

  if (compoundKeywords.some(k => name.includes(k))) {
    // Los primeros compuestos son "compound", los siguientes "compound_acc"
    return "compound";
  }
  if (isolationKeywords.some(k => name.includes(k))) {
    return "isolation";
  }
  return "compound_acc"; // default seguro
}

const CATEGORY_ORDER = {
  compound:     0,
  compound_acc: 1,
  isolation:    2,
  core:         3
};

function sortExercisesByCategory(exercises) {
  return [...exercises].sort((a, b) => {
    const catA = CATEGORY_ORDER[inferExerciseCategory(a)] ?? 2;
    const catB = CATEGORY_ORDER[inferExerciseCategory(b)] ?? 2;
    return catA - catB;
  });
}

// ─────────────────────────────────────────────
// SELECCIÓN DE EJERCICIOS
// ─────────────────────────────────────────────

// Devuelve { primary, fallback }
function filterExercises(exercises, profile) {
  const primaryDifficulties = {
    Beginner:     ["Beginner"],
    Intermediate: ["Beginner", "Intermediate"],
    Advanced:     ["Beginner", "Intermediate", "Advanced"]
  }[profile.experienceLevel] || ["Beginner"];

  // Para Beginner, el fallback añade Intermediate como último recurso
  const fallbackDifficulties = profile.experienceLevel === "Beginner"
    ? ["Intermediate"]
    : [];

  const baseFilter = ex => {
    if (!ex.isActive) return false;
    return (
      !profile.equipmentAvailable?.length ||
      ex.equipment.length === 0 ||
      ex.equipment.some(eq => profile.equipmentAvailable.includes(eq))
    );
  };

  return {
    primary:  exercises.filter(ex => baseFilter(ex) && primaryDifficulties.includes(ex.difficulty)),
    fallback: exercises.filter(ex => baseFilter(ex) && fallbackDifficulties.includes(ex.difficulty))
  };
}

/**
 * [FIX-1] usedSlugsThisWeek: Set de slugs ya usados en la semana.
 * Dentro de la sesión usamos un Set local.
 * Si el pool global se agota, se permite reutilizar ejercicios de
 * otras sesiones (el mismo slot de día no repetirá).
 *
 * [Q-9] musclesWorkedRecently: Map de muscleGroup → fecha (dateStr)
 * del último día en que se trabajó. Se usa para penalizar grupos
 * que no han tenido 48h de recuperación.
 */
function selectExercisesForSession(
  primaryExercises,
  fallbackExercises,
  allowedGroups,
  totalSlots,
  weeklyUsedSlugs,
  musclesWorkedRecently,
  currentDateStr
) {
  const budget = buildSessionBudget(allowedGroups, totalSlots);
  const selected = [];
  const sessionUsedSlugs = new Set(); // solo para esta sesión
  const groupCount = {};

  // Penalización de grupos que aún están en recuperación (<48h)
  function isRecoveryPenalized(muscleGroup) {
    const lastDate = musclesWorkedRecently.get(muscleGroup);
    if (!lastDate) return false;
    const diffMs = new Date(currentDateStr) - new Date(lastDate);
    const diffHours = diffMs / (1000 * 60 * 60);
    return diffHours < 48;
  }

  // Separar ejercicios de grupos en recuperación y los que no
  const pool = [...primaryExercises].sort(() => Math.random() - 0.5);
  const fresh    = pool.filter(ex => !isRecoveryPenalized(ex.muscleGroup));
  const recovery = pool.filter(ex =>  isRecoveryPenalized(ex.muscleGroup));

  // Intentar primero con ejercicios de grupos descansados
  for (const ex of [...fresh, ...recovery]) {
    if (selected.length >= totalSlots) break;

    const group = ex.muscleGroup;
    if (!allowedGroups.includes(group)) continue;
    if (sessionUsedSlugs.has(ex.slug)) continue;
    if ((groupCount[group] || 0) >= (budget[group] || 0)) continue;

    selected.push(ex);
    sessionUsedSlugs.add(ex.slug);
    weeklyUsedSlugs.add(ex.slug);
    groupCount[group] = (groupCount[group] || 0) + 1;
  }

  // Fallback en 3 niveles de restricción creciente
if (selected.length < totalSlots) {
  // Nivel 1: respeta allowedGroups + weeklyUsedSlugs, ignora budget
  for (const ex of [...fresh, ...recovery]) {
    if (selected.length >= totalSlots) break;
    if (!allowedGroups.includes(ex.muscleGroup)) continue;
    if (sessionUsedSlugs.has(ex.slug)) continue;
    if (weeklyUsedSlugs.has(ex.slug)) continue;
    selected.push(ex);
    sessionUsedSlugs.add(ex.slug);
    weeklyUsedSlugs.add(ex.slug);
  }
}

if (selected.length < totalSlots) {
  // Nivel 2: respeta allowedGroups, permite repetir slugs de la semana
  for (const ex of [...fresh, ...recovery]) {
    if (selected.length >= totalSlots) break;
    if (!allowedGroups.includes(ex.muscleGroup)) continue;
    if (sessionUsedSlugs.has(ex.slug)) continue;  // nunca repetir en la misma sesión
    selected.push(ex);
    sessionUsedSlugs.add(ex.slug);
  }
}

if (selected.length < totalSlots) {
  console.warn(`[WARN] Usando ejercicios Intermediate para perfil Beginner en ${currentDateStr}`);
  const extendedPool = [...primaryExercises, ...fallbackExercises].sort(() => Math.random() - 0.5);
  for (const ex of extendedPool) {
    if (selected.length >= totalSlots) break;
    if (sessionUsedSlugs.has(ex.slug)) continue;
    selected.push(ex);
    sessionUsedSlugs.add(ex.slug);
  }
}

  return selected;
}

/**
 * [Q-3] Formatea el ejercicio con progresión semanal aplicada.
 * [Q-4] Aplica modificadores de sets/reps según la semana del ciclo.
 */
function formatExercise(ex, profile, progression) {
  const isStrength = (ex.trainingContext || []).includes("strength") ||
                     (ex.trainingContext || []).includes("strength");

  // Sets base
  let sets = profile.experienceLevel === "Beginner" ? 2 : 3;
  // Reps base según objetivo
  let reps = profile.goal === "GAIN" ? 8 : profile.goal === "LOSE" ? 15 : 12;

  // [Q-4] Aplicar modificadores de progresión
  sets = Math.max(1, sets + progression.setsModifier);
  if (typeof reps === "number") {
    reps = Math.max(4, reps + progression.repsModifier);
  }

  // [Q-6] RPE
  const effectiveIntensity = progression.intensityOverride || profile.intensity || "moderate";
  const rpeInfo = RPE_MAP[effectiveIntensity] || RPE_MAP.moderate;

  return {
    slug:          ex.slug,
    name:          ex.nameEs || ex.name || ex.slug,
    muscleGroup:   ex.muscleGroup,
    category:      inferExerciseCategory(ex),
    primaryMuscles: ex.primaryMuscles,
    sets,
    reps:          isStrength ? reps : "45 segundos",
    rest:          profile.experienceLevel === "Beginner" ? 90 : progression.deload ? 90 : 60,
    rpe:           rpeInfo.rpe,
    rpeLabel:      rpeInfo.label,
    imageUrl:      ex.imageUrl || null,
    difficulty:    ex.difficulty,
    metValue:      ex.metValue
  };
}

// ─────────────────────────────────────────────
// [Q-1] TIMING NUTRICIONAL
// ─────────────────────────────────────────────

/**
 * Clasifica cada comida respecto al entrenamiento:
 *   "pre"   → la comida justo antes del entreno
 *   "post"  → la comida justo después del entreno
 *   "other" → resto
 *
 * Asume hora de entrenamiento en approximateWorkoutHour (ej. 19).
 * Mapa de slots horarios aproximados por tipo de comida:
 *   desayuno → 8, almuerzo → 13, merienda → 17, cena → 20, snack → depende
 */
const MEAL_HOUR_APPROX = {
  desayuno: 8,
  almuerzo: 13,
  merienda: 17,
  snack:    16,
  cena:     20
};

function classifyMealTiming(mealType, workoutHour) {
  const mealHour = MEAL_HOUR_APPROX[mealType] ?? 12;
  const diff = mealHour - workoutHour;

  if (diff >= -2 && diff < 0)  return "pre";   // 0-2h antes del entreno
  if (diff >= 0  && diff <= 2) return "post";  // 0-2h después del entreno
  return "other";
}

/**
 * Devuelve los requisitos nutricionales ajustados para cada timing.
 * Se usa como filtro de puntuación, no como filtro duro.
 */
function getTimingRequirements(timing) {
  switch (timing) {
    case "pre":
      return { carbsWeight: 1.5, proteinWeight: 1.0, fatWeight: 0.5 };  // carbos prioritarios
    case "post":
      return { carbsWeight: 1.3, proteinWeight: 1.8, fatWeight: 0.3 };  // proteína + carbos
    default:
      return { carbsWeight: 1.0, proteinWeight: 1.0, fatWeight: 1.0 };
  }
}

// ─────────────────────────────────────────────
// [Q-2] MACROS DIFERENCIADOS POR DÍA
// ─────────────────────────────────────────────

/**
 * Calcula los macros objetivo diferenciados para el día.
 * Proteína constante siempre.
 * Días entrenamiento: carbos +20%, grasa −15%
 * Días descanso: carbos −15%, grasa +15%
 *
 * Se recalcula desde calorías para mantener coherencia:
 * protein y carbs = 4 kcal/g, fat = 9 kcal/g
 */
function computeDailyMacros(profile, isTrainingDay) {
  const base = profile.calculations.macros;
  const protein = base.protein; // constante

  if (isTrainingDay) {
    const carbs = Math.round(base.carbs * 1.20);
    const fat   = Math.round(base.fat   * 0.85);
    return { protein, carbs, fat, type: "training_day" };
  } else {
    const carbs = Math.round(base.carbs * 0.85);
    const fat   = Math.round(base.fat   * 1.15);
    return { protein, carbs, fat, type: "rest_day" };
  }
}

// ─────────────────────────────────────────────
// SELECCIÓN DE RECETAS
// ─────────────────────────────────────────────

// Distribución calórica base por franja
const MEAL_CALORIE_SPLIT = {
  desayuno: 0.25,
  almuerzo: 0.35,
  cena:     0.30,
  snack:    0.10,
  merienda: 0.10
};

/**
 * [FIX-2] Filtra recetas con datos nutricionales válidos (calories > 0).
 */
function filterRecipes(recipes, profile, mealType) {
  return recipes.filter(r => {
    // meal_type debe coincidir
    const mealOk = r.classification?.meal_type?.some(mt =>
      mt.toLowerCase() === mealType.toLowerCase()
    );
    if (!mealOk) return false;

    // [FIX-2] Descartar recetas sin datos nutricionales válidos
    if (!r.nutrition?.calories || r.nutrition.calories <= 0) return false;
    if (!r.nutrition?.protein_g || r.nutrition.protein_g <= 0) return false;

    // Filtro de alergias
    if (profile.allergies?.length) {
      const ingredientText = (r.recipeIngredient || []).join(" ").toLowerCase();
      const hasAllergen = profile.allergies.some(a =>
        ingredientText.includes(a.toLowerCase())
      );
      if (hasAllergen) return false;
    }

    // Filtro de ingredientes excluidos
    if (profile.excludedIngredients?.length) {
      const ingredientText = (r.recipeIngredient || []).join(" ").toLowerCase();
      const hasExcluded = profile.excludedIngredients.some(e =>
        ingredientText.includes(e.toLowerCase())
      );
      if (hasExcluded) return false;
    }

    return true;
  });
}

/**
 * [Q-8] Calcula score compuesto para ranking de recetas.
 * Combina nutrition_score del objetivo, cercanía calórica,
 * timing (pre/post/other), y proteína mínima del slot.
 */
function scoreRecipe(recipe, goalKey, targetCalories, targetProtein, timingWeights) {
  // Penalizar fuertemente recetas sin slug (legacy sin datos completos)
  if (!recipe.identity?.slug) return -999;
  const nutritionScore =
    recipe.nutrition_score?.[goalKey] ||
    recipe.nutrition_score?.general ||
    0;

  const calories = recipe.nutrition?.calories || 0;
  const protein  = recipe.nutrition?.protein_g || 0;

  // Cercanía calórica: penalidad exponencial por desviación
  const calDiff    = Math.abs(calories - targetCalories);
  const calPenalty = calDiff / targetCalories; // 0 = perfecto, 1 = doble desviación

  // [Q-8] Proteína: bonus si cumple target, penalización si queda muy por debajo
  const proteinRatio  = targetProtein > 0 ? protein / targetProtein : 1;
  const proteinBonus  = proteinRatio >= 0.8 ? 1.0 : proteinRatio; // sin penalidad si cumple 80%

  // Timing: ajusta el peso relativo de macros
  const { carbsWeight, proteinWeight, fatWeight } = timingWeights;
  const carbsScore   = (recipe.nutrition?.carbs_g  || 0) / 50 * carbsWeight;
  const protScore    = (recipe.nutrition?.protein_g || 0) / 40 * proteinWeight;
  const fatScore     = (1 - (recipe.nutrition?.fat_g || 0) / 30) * fatWeight;

  const timingScore = (carbsScore + protScore + fatScore) / (carbsWeight + proteinWeight + fatWeight);

  // Score final: nutrition_score es lo más importante, el resto ajusta
  return (
    nutritionScore * 2.0 +
    (1 - calPenalty) * 1.0 +
    proteinBonus * 1.0 +
    timingScore * 0.5
  );
}

function selectRecipeForMeal(
  recipes,
  profile,
  mealType,
  targetCalories,
  targetProtein,
  usedSlugsByMealType,
  mealTiming           // "pre" | "post" | "other"
) {
  const goalKey    = profile.goalNormalized;
  const candidates = filterRecipes(recipes, profile, mealType);
  if (!candidates.length) return null;

  const usedForMeal = usedSlugsByMealType[mealType] || new Set();
  const fresh       = candidates.filter(r => !usedForMeal.has(r.identity?.slug));
  const pool        = fresh.length > 0 ? fresh : candidates;

  const timingWeights = getTimingRequirements(mealTiming);

  // Ordenar por score compuesto descendente
  const sorted = [...pool].sort((a, b) =>
    scoreRecipe(b, goalKey, targetCalories, targetProtein, timingWeights) -
    scoreRecipe(a, goalKey, targetCalories, targetProtein, timingWeights)
  );

  return sorted[0] || null;
}

function buildDayNutrition(
  recipes,
  profile,
  isTrainingDay,
  usedSlugsByMealType,
  workoutHour  // [Q-1]
) {
  const dailyTarget  = isTrainingDay
    ? profile.calculations.trainingDayCalories
    : profile.calculations.restDayCalories;

  // [Q-2] Macros diferenciados
  const dailyMacros = computeDailyMacros(profile, isTrainingDay);

  const mealTypes = ["desayuno", "almuerzo", "cena"];
  if (profile.mealsPerDay >= 4) mealTypes.push("snack");

  const meals = [];

  for (const mealType of mealTypes) {
    const split       = MEAL_CALORIE_SPLIT[mealType] || 0.25;
    const targetCal   = Math.round(dailyTarget * split);
    const targetProt  = Math.round(dailyMacros.protein * split * 1.1); // protein target por slot

    // [Q-1] Clasificar timing de esta comida respecto al entrenamiento
    const timing = isTrainingDay
      ? classifyMealTiming(mealType, workoutHour)
      : "other";

    const recipe = selectRecipeForMeal(
      recipes,
      profile,
      mealType,
      targetCal,
      targetProt,
      usedSlugsByMealType,
      timing
    );

    if (recipe) {
      if (!usedSlugsByMealType[mealType]) {
        usedSlugsByMealType[mealType] = new Set();
      }
      usedSlugsByMealType[mealType].add(recipe.identity?.slug);

      const actualCal = recipe.nutrition?.calories || 0;

      // [Q-7] portionMultiplier: ratio para que el frontend pueda escalar
      const portionMultiplier = targetCal > 0 && actualCal > 0
        ? parseFloat((targetCal / actualCal).toFixed(2))
        : 1.0;
      
      if (recipe) {
        const MAX_REASONABLE_MULTIPLIER = 1.5;
        let finalRecipe = recipe;

        const firstCal = recipe.nutrition?.calories || 0;
        let portionMultiplier = targetCal > 0 && firstCal > 0
          ? parseFloat((targetCal / firstCal).toFixed(2))
          : 1.0;

        if (portionMultiplier > MAX_REASONABLE_MULTIPLIER) {
          const higherCalCandidates = filterRecipes(recipes, profile, mealType)
            .filter(r => {
              const slug = r.identity?.slug;
              const used = usedSlugsByMealType[mealType] || new Set();
              if (used.has(slug)) return false;
              if (!r.nutrition?.calories || r.nutrition.calories <= 0) return false;
              const m = targetCal / r.nutrition.calories;
              return m <= MAX_REASONABLE_MULTIPLIER && m >= 0.7;
            });

          if (higherCalCandidates.length > 0) {
            higherCalCandidates.sort((a, b) =>
              (b.nutrition_score?.[profile.goalNormalized] || 0) -
              (a.nutrition_score?.[profile.goalNormalized] || 0)
            );
            finalRecipe = higherCalCandidates[0];
            const newCal = finalRecipe.nutrition?.calories || 0;
            portionMultiplier = targetCal > 0 && newCal > 0
              ? parseFloat((targetCal / newCal).toFixed(2))
              : 1.0;
          }
        }

        // Marcar como usada la receta FINAL (no la inicial)
        if (!usedSlugsByMealType[mealType]) {
          usedSlugsByMealType[mealType] = new Set();
        }
        usedSlugsByMealType[mealType].add(finalRecipe.identity?.slug);

        const actualCal = finalRecipe.nutrition?.calories || 0;

        meals.push({
          mealType,
          timing,
          slug:              finalRecipe.identity?.slug || null,
          name:              finalRecipe.name && !finalRecipe.name.includes("-")
                              ? finalRecipe.name
                              : finalRecipe.identity?.slug?.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || "Sin nombre",
          calories:          actualCal,
          protein:           finalRecipe.nutrition?.protein_g || 0,
          carbs:             finalRecipe.nutrition?.carbs_g   || 0,
          fat:               finalRecipe.nutrition?.fat_g     || 0,
          fiber:             finalRecipe.nutrition?.fiber_g   || null,
          nutritionScore:    finalRecipe.nutrition_score?.[profile.goalNormalized] ?? null,
          portionMultiplier,
          url:               finalRecipe.identity?.url || null
        });
      }

      meals.push({
        mealType,
        timing,                              // [Q-1] pre | post | other
        slug:             recipe.identity?.slug || null,
        name: recipe.name && !recipe.name.includes("-")   // el slug siempre tiene guiones
          ? recipe.name
          : recipe.identity?.slug
              ?.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
              || "Sin nombre",
        calories:         actualCal,
        protein:          recipe.nutrition?.protein_g || 0,
        carbs:            recipe.nutrition?.carbs_g   || 0,
        fat:              recipe.nutrition?.fat_g      || 0,
        fiber:            recipe.nutrition?.fiber_g   || null,
        nutritionScore:   recipe.nutrition_score?.[profile.goalNormalized] ?? null,
        portionMultiplier,                   // [Q-7]
        url:              recipe.identity?.url || null
      });
    }
  }

  const totals = meals.reduce(
    (acc, m) => ({
      calories: acc.calories + (m.calories || 0),
      protein:  acc.protein  + (m.protein  || 0),
      carbs:    acc.carbs    + (m.carbs    || 0),
      fat:      acc.fat      + (m.fat      || 0)
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );

  return {
    targetCalories: dailyTarget,
    targetMacros:   dailyMacros,             // [Q-2] diferenciados por día
    actualTotals:   totals,
    calorieDeviation: totals.calories - dailyTarget,
    meals
  };
}

// ─────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────

function createEvent(eventType, payload, userProfile, sessionId) {
  return {
    eventId:   randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId,
    eventType,
    userSnapshot: {
      userId:              userProfile.userId,
      goal:                userProfile.goal,
      goalNormalized:      userProfile.goalNormalized,
      experienceLevel:     userProfile.experienceLevel,
      trainingDaysPerWeek: userProfile.availableDays.length,
      age:                 userProfile.age,
      gender:              userProfile.gender,
      weightKg:            userProfile.weightKg
    },
    payload
  };
}

function generatePlanEvents(weekPlan, profile, sessionId, progression) {
  const events = [];

  events.push(createEvent(
    "PLAN_GENERATED",
    {
      weekNumber:        weekPlan.weekNumber,
      phase:             weekPlan.phase,
      progressionPhase:  progression.phase,  // base | volume | intensity | deload
      startDate:         weekPlan.startDate,
      endDate:           weekPlan.endDate,
      totalTrainingDays: weekPlan.days.filter(d => d.isTrainingDay).length,
      totalRestDays:     weekPlan.days.filter(d => !d.isTrainingDay).length,
      generatorVersion:  VERSION,
      splitType:         weekPlan.metadata.splitType
    },
    profile,
    sessionId
  ));

  weekPlan.days.forEach(day => {
    if (day.workout?.exercises) {
      day.workout.exercises.forEach((ex, position) => {
        events.push(createEvent(
          "EXERCISE_SHOWN",
          {
            itemId:   ex.slug,
            itemType: "exercise",
            context: {
              date:            day.date,
              dayOfWeek:       day.dayOfWeek,
              weekNumber:      weekPlan.weekNumber,
              phase:           weekPlan.phase,
              sessionPosition: position,
              splitFocus:      day.workout.splitFocus,
              category:        ex.category    // [Q-3] para análisis ML
            },
            exerciseMetadata: {
              muscleGroup: ex.muscleGroup,
              difficulty:  ex.difficulty,
              sets:        ex.sets,
              reps:        ex.reps,
              rpe:         ex.rpe,
              metValue:    ex.metValue
            }
          },
          profile,
          sessionId
        ));
      });
    }

    if (day.nutrition?.meals) {
      day.nutrition.meals.forEach((meal, position) => {
        events.push(createEvent(
          "RECIPE_SHOWN",
          {
            itemId:   meal.slug || meal.name,  // [FIX-9] fallback a name si no hay slug
            itemType: "recipe",
            isLegacyRecipe: !meal.slug,
            context: {
              date:          day.date,
              dayOfWeek:     day.dayOfWeek,
              weekNumber:    weekPlan.weekNumber,
              phase:         weekPlan.phase,
              mealType:      meal.mealType,
              mealTiming:    meal.timing,       // [Q-1]
              mealPosition:  position,
              isTrainingDay: day.isTrainingDay
            },
            recipeMetadata: {
              calories:          meal.calories,
              protein:           meal.protein,
              nutritionScore:    meal.nutritionScore,
              calorieTarget:     day.nutrition.targetCalories,
              portionMultiplier: meal.portionMultiplier  // [Q-7]
            }
          },
          profile,
          sessionId
        ));
      });
    }
  });

  return events;
}

// ─────────────────────────────────────────────
// GENERADOR PRINCIPAL
// ─────────────────────────────────────────────

const DAYS_ES = [
  "domingo", "lunes", "martes", "miércoles",
  "jueves", "viernes", "sábado"
];

function generateWeek(profile, exercises, recipes, weekNumber) {
  const sessionId    = randomUUID();
  const startDateObj = new Date(profile.startDate);

  // [Q-4] Progresión semanal
  const progression = getWeeklyProgression(weekNumber);

  const trainingDays = profile.availableDays.length;
  const splitMap     = determineSplit(trainingDays);
  const splitNames   = SPLIT_NAMES[trainingDays] || ["Full Body"];

  // [FIX-3] Filtrar ejercicios solo por difficulty y equipment
  const { primary: primaryExercises, fallback: fallbackExercises } = filterExercises(exercises, profile);

  // Estado semanal
  const weeklyUsedSlugs      = new Set();  // [FIX-1] slugs usados en la semana
  const usedSlugsByMealType  = {};
  const musclesWorkedRecently = new Map(); // [Q-9] { muscleGroup → dateStr }
  let   trainingDayIndex     = 0;

  const days = [];

  for (let i = 0; i < 7; i++) {
    const date    = new Date(startDateObj);
    date.setDate(startDateObj.getDate() + i);

    const dayOfWeek = DAYS_ES[date.getDay()];
    const dateStr   = date.toISOString().split("T")[0];
    const dayEN     = date.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
    const isTrainingDay = profile.availableDays.includes(dayEN);

    let workout = null;

    if (isTrainingDay) {
      const splitIndex   = trainingDayIndex % Object.keys(splitMap).length;
      const allowedGroups = splitMap[splitIndex];
      const splitFocus   = splitNames[splitIndex] || "Full Body";

      // Slots de ejercicio según duración (deload reduce slots)
      let exerciseSlots = profile.sessionDuration >= 60 ? 6
        : profile.sessionDuration >= 45 ? 5 : 4;
      if (progression.deload) exerciseSlots = Math.max(3, exerciseSlots - 2);

      const rawExercises = selectExercisesForSession(
        primaryExercises,
        fallbackExercises,
        allowedGroups,
        exerciseSlots,
        weeklyUsedSlugs,
        musclesWorkedRecently,
        dateStr
      );

      // [Q-3] Ordenar por categoría: compound → isolation → core
      const orderedExercises = sortExercisesByCategory(rawExercises);

      // [Q-9] Registrar grupos trabajados hoy
      orderedExercises.forEach(ex => {
        musclesWorkedRecently.set(ex.muscleGroup, dateStr);
      });

      // [Q-5] Warmup y cooldown específicos
      const warmup   = WARMUP_BY_SPLIT[splitFocus]   || WARMUP_DEFAULT;
      const cooldown = COOLDOWN_BY_SPLIT[splitFocus] || COOLDOWN_DEFAULT;

      // [Q-6] RPE efectivo
      const effectiveIntensity = progression.intensityOverride || profile.intensity || "moderate";
      const rpeInfo = RPE_MAP[effectiveIntensity] || RPE_MAP.moderate;

      workout = {
        type:       profile.trainingTypes[0] || "strength",
        splitFocus,
        duration:   progression.deload
          ? Math.round(profile.sessionDuration * 0.75)
          : profile.sessionDuration,
        intensity:  effectiveIntensity,
        rpe:        rpeInfo.rpe,
        rpeLabel:   rpeInfo.label,
        progression: {                       // [Q-4] metadatos visibles
          phase:         progression.phase,
          weekInCycle:   ((weekNumber - 1) % 4) + 1,
          label:         progression.label,
          deload:        progression.deload
        },
        warmup,
        exercises: orderedExercises.map(ex => formatExercise(ex, profile, progression)),
        cooldown
      };

      trainingDayIndex++;
    }

    const workoutHour = profile.approximateWorkoutHour ?? 18;

    const nutrition = buildDayNutrition(
      recipes,
      profile,
      isTrainingDay,
      usedSlugsByMealType,
      workoutHour
    );

    days.push({
      date: dateStr,
      dayOfWeek,
      dayNumber: i + 1,
      isTrainingDay,
      workout,
      nutrition
    });
  }

  const weekPlan = {
    userId:     profile.userId,
    sessionId,
    weekNumber,
    phase:      progression.phase,
    startDate:  profile.startDate,
    endDate:    new Date(
      new Date(profile.startDate).getTime() + 6 * 24 * 60 * 60 * 1000
    ).toISOString().split("T")[0],
    metadata: {
      generatorVersion: VERSION,
      splitType:        splitNames,
      trainingDaysPerWeek: trainingDays,
      progressionPhase: progression.phase,
      progressionLabel: progression.label,
      generatedAt:      new Date().toISOString()
    },
    days
  };

  const events = generatePlanEvents(weekPlan, profile, sessionId, progression);
  return { weekPlan, events };
}

// ─────────────────────────────────────────────
// EJECUCIÓN
// ─────────────────────────────────────────────

function run() {
  const exercises = JSON.parse(
    fs.readFileSync(path.resolve("./data/exercises.json"), "utf-8")
  );
  const recipes = JSON.parse(
    fs.readFileSync(path.resolve("./data/recipes.json"), "utf-8")
  );

  if (!fs.existsSync("./output")) fs.mkdirSync("./output");
  if (!fs.existsSync("./logs"))   fs.mkdirSync("./logs");

  const allEvents = [];

  console.log(`\n═══════════════════════════════════════`);
  console.log(`  Sporvit Plan Engine ${VERSION} — Semana ${WEEK_NUMBER}`);
  console.log(`  Fase: ${getWeeklyProgression(WEEK_NUMBER).label}`);
  console.log(`═══════════════════════════════════════\n`);

  profiles.forEach(profile => {
    console.log(`── Generando plan para ${profile.userId} ──`);

    const { weekPlan, events } = generateWeek(profile, exercises, recipes, WEEK_NUMBER);

    const planPath = `./output/plan_${profile.userId}.json`;
    fs.writeFileSync(planPath, JSON.stringify(weekPlan, null, 2));
    console.log(`✓ Plan guardado: ${planPath}`);

    const eventsPath = `./logs/events_${profile.userId}.jsonl`;
    fs.writeFileSync(eventsPath, events.map(e => JSON.stringify(e)).join("\n"));
    console.log(`✓ Eventos: ${eventsPath} (${events.length} eventos)`);

    allEvents.push(...events);

    const trainingDaysResult = weekPlan.days.filter(d => d.isTrainingDay);
    const totalExercises = trainingDaysResult.reduce(
      (acc, d) => acc + (d.workout?.exercises?.length || 0), 0
    );
    const totalMeals = weekPlan.days.reduce(
      (acc, d) => acc + (d.nutrition?.meals?.length || 0), 0
    );
    const emptyWorkouts = trainingDaysResult.filter(
      d => !d.workout?.exercises?.length
    ).length;

    // Resumen de calidad nutricional
    const avgDeviation = weekPlan.days.reduce(
      (acc, d) => acc + Math.abs(d.nutrition?.calorieDeviation || 0), 0
    ) / 7;

    console.log(`  Días entrenamiento : ${trainingDaysResult.length}`);
    console.log(`  Ejercicios totales : ${totalExercises}`);
    console.log(`  Sesiones vacías    : ${emptyWorkouts} ${emptyWorkouts > 0 ? "⚠️" : "✓"}`);
    console.log(`  Comidas totales    : ${totalMeals}`);
    console.log(`  Desviación cal/día : ~${Math.round(avgDeviation)} kcal`);
    console.log(`  Split              : ${weekPlan.metadata.splitType.join(" / ")}`);
    console.log(`  Fase ciclo         : ${weekPlan.metadata.progressionLabel}\n`);
  });

  fs.writeFileSync(
    "./logs/events_all.jsonl",
    allEvents.map(e => JSON.stringify(e)).join("\n")
  );
  console.log(`✓ Log global: ./logs/events_all.jsonl (${allEvents.length} eventos totales)`);
  console.log("\n¡Listo! Planes en ./output — Logs en ./logs\n");
}

run();