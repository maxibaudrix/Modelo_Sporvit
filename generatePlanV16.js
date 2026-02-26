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

const VERSION = "v15";

// Número de semana inyectable por CLI (--week N)
const weekArg   = process.argv.indexOf("--week");
const WEEK_NUMBER = weekArg !== -1 ? parseInt(process.argv[weekArg + 1], 10) : 1;

const weeksArg  = process.argv.indexOf("--weeks");
const TOTAL_WEEKS = weeksArg !== -1 ? parseInt(process.argv[weeksArg + 1], 10) : 1;

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

// Filtros de MET mínimo por fase para filterExercises
const PHASE_MET_FILTER = {
  base:      { min: 0,   max: 99 },   // sin restricción
  volume:    { min: 0,   max: 99 },   // sin restricción
  intensity: { min: 4.0, max: 99 },   // solo ejercicios de al menos MET 4
  deload:    { min: 0,   max: 5.0 }   // excluir ejercicios de muy alta intensidad
};

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
function filterExercises(exercises, profile, phase = "base") {
  const primaryDifficulties = {
    Beginner:     ["Beginner"],
    Intermediate: ["Beginner", "Intermediate"],
    Advanced:     ["Beginner", "Intermediate", "Advanced"]
  }[profile.experienceLevel] || ["Beginner"];

  // Para Beginner, el fallback añade Intermediate como último recurso
  const fallbackDifficulties = profile.experienceLevel === "Beginner"
    ? ["Intermediate"]
    : [];

  const metFilter = PHASE_MET_FILTER[phase] || PHASE_MET_FILTER.base;

  const baseFilter = ex => {
    if (!ex.isActive) return false;
    const met = ex.metValue || 0;
    if (met < metFilter.min || met > metFilter.max) return false;
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
  console.warn(`[WARN] Pool insuficiente en ${currentDateStr} — slots: ${selected.length}/${totalSlots}, grupos: ${allowedGroups.join(",")}`);
  const extendedPool = [...primaryExercises, ...fallbackExercises].sort(() => Math.random() - 0.5);
  for (const ex of extendedPool) {
    if (selected.length >= totalSlots) break;
    if (!allowedGroups.includes(ex.muscleGroup)) continue;  // ← AÑADIR ESTA LÍNEA
    if (sessionUsedSlugs.has(ex.slug)) continue;
    selected.push(ex);
    sessionUsedSlugs.add(ex.slug);
  }
  // Si tras respetar allowedGroups sigue sin llenarse, loguear cuántos slots quedaron vacíos
  if (selected.length < totalSlots) {
    console.warn(`[WARN] Sesión incompleta: ${selected.length}/${totalSlots} ejercicios. BD insuficiente para grupos: ${allowedGroups.join(",")}`);
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
  console.warn(`[WARN] Usando fallback extendido (Beginner+Intermediate) en ${currentDateStr}`);
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

  const baseSetsByCategory = {
    compound:     profile.experienceLevel === "Beginner" ? 2 : 4,
    compound_acc: profile.experienceLevel === "Beginner" ? 2 : 3,
    isolation:    profile.experienceLevel === "Beginner" ? 2 : 3,
    core:         profile.experienceLevel === "Beginner" ? 2 : 3,
  };
  const exCategory = inferExerciseCategory(ex);
  let sets = baseSetsByCategory[exCategory] || (profile.experienceLevel === "Beginner" ? 2 : 3);
  
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
  
  let primaryMuscles = ex.primaryMuscles;
  if (typeof primaryMuscles === "string") {
    try {
      primaryMuscles = JSON.parse(primaryMuscles);
    } catch {
      primaryMuscles = [primaryMuscles];
    }
  }

  return {
    slug:          ex.slug,
    name:          ex.nameEs || ex.name || ex.slug,
    muscleGroup:   ex.muscleGroup,
    category:      inferExerciseCategory(ex),
    primaryMuscles,
    sets,
    reps:          isStrength ? reps : null,
    duration_seconds: !isStrength ? 45 : null,
    repScheme:     !isStrength ? "45 segundos" : null,
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

// ─────────────────────────────────────────────
// [FIX-BD] Normalización de schema de recetas (legacy + nuevo)
// ─────────────────────────────────────────────

function getNutricion(recipe) {
  // Nuevo schema: nutrition.per_serving
  if (recipe.nutrition?.per_serving) return recipe.nutrition.per_serving;
  // Legacy schema: nutrition directamente
  if (recipe.nutrition?.calories != null) return recipe.nutrition;
  return {};
}

function getNutritionScore(recipe, goalKey) {
  let raw = null;
  let maxScale = 25; // asumir legacy por defecto

  if (recipe.nutrition?.nutrition_score) {
    raw = recipe.nutrition.nutrition_score[goalKey]
       || recipe.nutrition.nutrition_score.general
       || null;
    maxScale = 5; // nuevo schema siempre escala 0-5
  } else if (recipe.nutrition_score) {
    raw = recipe.nutrition_score[goalKey]
       || recipe.nutrition_score.general
       || null;
    // Legacy: si el valor es <= 5 probablemente también es escala 0-5
    maxScale = (raw != null && raw <= 5) ? 5 : 25;
  }

  if (raw == null) return null;
  // Normalizar a 0-10
  return parseFloat(((raw / maxScale) * 10).toFixed(2));
}

function getNombreReceta(recipe) {
  // Nuevo schema: localization.es.name o name en raíz
  const nameEs = recipe.localization?.es?.name || recipe.name;
  if (nameEs && !nameEs.includes("-")) return nameEs;
  // Fallback: slug humanizado
  const slug = recipe.identity?.slug || recipe.slug || "";
  return slug.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || "Sin nombre";
}

function getSlug(recipe) {
  return recipe.identity?.slug || recipe.slug || null;
}

function getUrl(recipe) {
  return recipe.identity?.url || recipe.url || null;
}

// [v15] fix_cena_filter: "cena" hace fallback a "almuerzo" si no hay recetas propias
function filterRecipes(recipes, profile, mealType) {
  const lookupType = mealType === "cena" ? ["cena", "almuerzo"] : [mealType];

  return recipes.filter(r => {
    const mealOk = r.classification?.meal_type?.some(mt =>
      lookupType.includes(mt.toLowerCase())
    );
    if (!mealOk) return false;

    // [FIX-BD] usar helper para soportar ambos schemas
    const nut = getNutricion(r);
    if (!nut.calories || nut.calories <= 0) return false;
    if (!nut.protein_g || nut.protein_g <= 0) return false;

    if (profile.allergies?.length) {
      const ingredientText = (r.recipeIngredient || r.localization?.es?.recipeIngredient || []).join(" ").toLowerCase();
      const hasAllergen = profile.allergies.some(a => ingredientText.includes(a.toLowerCase()));
      if (hasAllergen) return false;
    }

    if (profile.excludedIngredients?.length) {
      const ingredientText = (r.recipeIngredient || r.localization?.es?.recipeIngredient || []).join(" ").toLowerCase();
      const hasExcluded = profile.excludedIngredients.some(e => ingredientText.includes(e.toLowerCase()));
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
  function scoreRecipe(recipe, goalKey, targetCalories, targetProtein, timingWeights, usedProteins = new Set(), fiberNeeded = false, weeklyRecipeCount = {}, slugHistory = {}, currentWeekNum = 1) {

  if (!(usedProteins instanceof Set)) usedProteins = new Set();
  if (!getSlug(recipe)) return -999;
  const rawScore = getNutritionScore(recipe, goalKey);
  // Fallback: estimar score por densidad proteica si no hay score
  const nutritionScore = rawScore !== null ? rawScore
    : (() => {
        const nut = getNutricion(recipe);
        if (!nut.calories) return 0;
        const proteinDensity = (nut.protein_g || 0) / nut.calories * 100; // g protein / 100kcal
        return Math.min(10, proteinDensity * 0.8); // heurística: 12.5g/100kcal = score 10
      })();
  const nut      = getNutricion(recipe);
  const calories = nut.calories || 0;
  const protein  = nut.protein_g || 0;

  // Cercanía calórica: penalidad exponencial por desviación
  const calDiff    = Math.abs(calories - targetCalories);
  const calPenalty = calDiff / targetCalories; // 0 = perfecto, 1 = doble desviación

  // [Q-8] Proteína: bonus si cumple target, penalización si queda muy por debajo
  const proteinRatio  = targetProtein > 0 ? protein / targetProtein : 1;
  const proteinBonus  = proteinRatio >= 0.8 ? 1.0 : proteinRatio; // sin penalidad si cumple 80%

  // Timing: ajusta el peso relativo de macros
  const { carbsWeight, proteinWeight, fatWeight } = timingWeights;
  const carbsScore = (nut.carbs_g  || 0) / 50 * carbsWeight;
  const protScore  = (nut.protein_g || 0) / 40 * proteinWeight;
  const fatScore   = (1 - (nut.fat_g || 0) / 30) * fatWeight;

  const timingScore = (carbsScore + protScore + fatScore) / (carbsWeight + proteinWeight + fatWeight);

  // Penalizar si la proteína principal ya se usó hoy
  const proteinSource = inferProteinSource(recipe);
  const proteinPenalty = proteinSource && usedProteins.has(proteinSource) ? -1.5 : 0;

  // Bonus fibra si el día aún no alcanza 25g
  const fiberBonus = fiberNeeded && (nut.fiber_g || 0) >= 5 ? 0.5 : 0;

  const slug = getSlug(recipe);
  const timesUsed = weeklyRecipeCount[slug] || 0;
  const repetitionPenalty = timesUsed === 0 ? 0
                        : timesUsed === 1 ? -2.0
                        : timesUsed === 2 ? -8.0
                        : timesUsed >= 3  ? -25.0  // [v16] diversity_v3: de -15 a -25
                        : 0;
  const weeksSinceUsed = slugHistory[slug] !== undefined 
    ? (currentWeekNum - slugHistory[slug]) 
    : 99;
  const crossWeekPenalty = weeksSinceUsed === 0 ? -8.0   // misma semana (ya cubierto por repetitionPenalty)
                        : weeksSinceUsed === 1 ? -3.0   // semana pasada
                        : weeksSinceUsed === 2 ? -1.0   // hace 2 semanas
                        : 0;                             // más antiguo: libre

  return (
    nutritionScore * 2.0 +
    (1 - calPenalty) * 1.0 +
    proteinBonus * 1.0 +
    timingScore * 0.5 +
    proteinPenalty +
    fiberBonus +
    repetitionPenalty +
    crossWeekPenalty
  );
}

function selectRecipeForMeal(recipes, profile, mealType, targetCalories, targetProtein, usedSlugsByMealType, mealTiming, usedProteins = new Set(), fiberNeeded = false, weeklyRecipeCount = {}, slugHistory = {}, currentWeekNum = 1) {

  const goalKey    = profile.goalNormalized;
  const candidates = filterRecipes(recipes, profile, mealType);
  if (!candidates.length) return null;

  const usedForMeal   = usedSlugsByMealType[mealType] || new Set();
  const usedSlugsArr  = [...usedForMeal];
  const lastUsedSlug  = usedSlugsArr[usedSlugsArr.length - 1]; // la más reciente

  // Nivel 1: nunca usada esta semana
  const fresh = candidates.filter(r => !usedForMeal.has(getSlug(r)));

  // Nivel 2: pool agotado — al menos evitar la última usada
  const avoidLast = candidates.filter(r => getSlug(r) !== lastUsedSlug);

  // Nivel 3: rendirse, usar todo el pool
  const pool = fresh.length > 0 ? fresh
             : avoidLast.length > 0 ? avoidLast
             : candidates;

  const timingWeights = getTimingRequirements(mealTiming);
  const sorted = [...pool].sort((a, b) =>
    scoreRecipe(b, goalKey, targetCalories, targetProtein, timingWeights, usedProteins, fiberNeeded, weeklyRecipeCount, slugHistory, currentWeekNum) -
    scoreRecipe(a, goalKey, targetCalories, targetProtein, timingWeights, usedProteins, fiberNeeded, weeklyRecipeCount, slugHistory, currentWeekNum)
  );
  return sorted[0] || null;
}

const PROTEIN_KEYWORDS = ["pollo", "pechuga", "salmón", "salmon", "atún", "atun",
  "merluza", "bacalao", "ternera", "pavo", "huevo", "tofu", "gambas", "cerdo", "lentejas"];

function inferProteinSource(recipe) {
  const text = (getNombreReceta(recipe) + " " +
    (recipe.recipeIngredient || recipe.localization?.es?.recipeIngredient || []).join(" ")
  ).toLowerCase();
  return PROTEIN_KEYWORDS.find(k => text.includes(k)) || null;
}

function buildDayNutrition(recipes, profile, isTrainingDay, usedSlugsByMealType, workoutHour, dailyProteinSources, dateStr, recentProteinsByDate, phase = "base", slugHistory = {}, currentWeekNum = 1) {
  
  const deloadCalorieReduction = (phase === "deload") ? 0.90 : 1.0;
  const dailyTarget  = isTrainingDay
    ? Math.round(profile.calculations.trainingDayCalories * deloadCalorieReduction)
    : Math.round(profile.calculations.restDayCalories    * deloadCalorieReduction);

  const dailyMacros = computeDailyMacros(profile, isTrainingDay);

  // [v15] orden canónico garantizado: desayuno → almuerzo → cena → snack
  const mealTypes = profile.mealsPerDay >= 4
    ? ["desayuno", "almuerzo", "cena", "snack"]
    : ["desayuno", "almuerzo", "cena"];

  const meals = [];
  const MAX_REASONABLE_MULTIPLIER = 2.0;
  let dailyFiberSoFar = 0;

  // [v7] Conteo de slugs usados esta semana en todos los tipos de comida
  const weeklyRecipeCount = {};
  Object.values(usedSlugsByMealType).forEach(slugSet => {
    slugSet.forEach(slug => {
      weeklyRecipeCount[slug] = (weeklyRecipeCount[slug] || 0) + 1;
    });
  });

  for (const mealType of mealTypes) {
    const split      = MEAL_CALORIE_SPLIT[mealType] || 0.25;
    const targetCal  = Math.round(dailyTarget * split);
    const targetProt = Math.round(dailyMacros.protein * split * 1.1);

    const timing = isTrainingDay
      ? classifyMealTiming(mealType, workoutHour)
      : "other";

    const todayProteins   = dailyProteinSources[dateStr] || new Set();
    const recentProteins  = recentProteinsByDate[dateStr] || new Set();
    const usedProteins    = new Set([...todayProteins, ...recentProteins]);
    const fiberNeeded  = dailyFiberSoFar < 25;

    const recipe = selectRecipeForMeal(
      recipes, profile, mealType, targetCal, targetProt,
      usedSlugsByMealType, timing, usedProteins, fiberNeeded, weeklyRecipeCount,
      slugHistory, currentWeekNum
    );


    if (recipe) {
      let finalRecipe = recipe;

      const firstCal = getNutricion(recipe).calories || 0;
      let portionMultiplier = targetCal > 0 && firstCal > 0
        ? parseFloat((targetCal / firstCal).toFixed(2))
        : 1.0;

      // [v14] Mínimo 0.8 para snack y merienda
      if (mealType === "snack" || mealType === "merienda") {
        portionMultiplier = Math.max(0.8, portionMultiplier);
      }

      if (portionMultiplier > MAX_REASONABLE_MULTIPLIER) {
        // [v16] min_slot_calories: buscar receta con calories >= targetCal * 0.6
        const MIN_CAL_RATIO = 0.6;
        const higherCalCandidates = filterRecipes(recipes, profile, mealType)
          .filter(r => {
            const slug = getSlug(r);
            const used = usedSlugsByMealType[mealType] || new Set();
            if (used.has(slug)) return false;
            const rNut = getNutricion(r);
            if (!rNut.calories || rNut.calories <= 0) return false;
            const m = targetCal / rNut.calories;
            return m <= MAX_REASONABLE_MULTIPLIER && m >= 0.7;
          });

        if (higherCalCandidates.length > 0) {
          higherCalCandidates.sort((a, b) =>
            (getNutritionScore(b, profile.goalNormalized) || 0) -
            (getNutritionScore(a, profile.goalNormalized) || 0)
          );
          finalRecipe = higherCalCandidates[0];
          const newCal = getNutricion(finalRecipe).calories || 0;
          portionMultiplier = targetCal > 0 && newCal > 0
            ? parseFloat((targetCal / newCal).toFixed(2))
            : 1.0;
        } else {
          // [v16] min_slot_calories: higherCalCandidates vacío — buscar cualquier receta
          // del slot con calories >= targetCal * MIN_CAL_RATIO, ignorando usedSlugsByMealType
          const minCalFloor = targetCal * MIN_CAL_RATIO;
          const fallbackCandidates = filterRecipes(recipes, profile, mealType)
            .filter(r => {
              const rNut = getNutricion(r);
              return rNut.calories >= minCalFloor;
            })
            .sort((a, b) => {
              // Preferir la que tenga calorías más cercanas al target
              const aDiff = Math.abs(getNutricion(a).calories - targetCal);
              const bDiff = Math.abs(getNutricion(b).calories - targetCal);
              return aDiff - bDiff;
            });

          if (fallbackCandidates.length > 0) {
            finalRecipe = fallbackCandidates[0];
            const fbCal = getNutricion(finalRecipe).calories || 0;
            portionMultiplier = targetCal > 0 && fbCal > 0
              ? parseFloat((targetCal / fbCal).toFixed(2))
              : 1.0;
            console.warn(`[v16][MIN_SLOT_CAL] ${dateStr} ${mealType} — receta original demasiado baja (${firstCal} kcal). Fallback: "${getNombreReceta(finalRecipe)}" (${fbCal} kcal)`);
          } else {
            // Sin fallback disponible: mantener receta original y loggear
            console.error(`[v16][MIN_SLOT_CAL_FAIL] ${dateStr} ${mealType} — sin recetas con ≥${Math.round(minCalFloor)} kcal en BD. Revisar recetas de tipo "${mealType}".`);
          }
        }
      }
      
      // [v15] extreme_portion_warn
      if (portionMultiplier > 1.8) {
        console.warn(`[v15][EXTREME_PORTION] ${dateStr} ${mealType} ×${portionMultiplier} — "${getNombreReceta(finalRecipe)}" (${getNutricion(finalRecipe).calories} kcal) para target ${targetCal} kcal`);
      }

      if (!usedSlugsByMealType[mealType]) {
        usedSlugsByMealType[mealType] = new Set();
      }
      usedSlugsByMealType[mealType].add(getSlug(finalRecipe));

      const nut = getNutricion(finalRecipe);

      meals.push({
        mealType,
        timing,
        slug:           getSlug(finalRecipe),
        name:           getNombreReceta(finalRecipe),
        calories:       nut.calories  || 0,
        protein:        nut.protein_g || 0,
        carbs:          nut.carbs_g   || 0,
        fat:            nut.fat_g     || 0,
        fiber:          nut.fiber_g   || null,
        nutritionScore: getNutritionScore(finalRecipe, profile.goalNormalized),
        portionMultiplier,
        portionLabel: portionMultiplier >= 1.8 ? "porción grande (×" + portionMultiplier + ")"
                    : portionMultiplier >= 1.2 ? "porción ampliada (×" + portionMultiplier + ")"
                    : portionMultiplier <= 0.8 ? "porción reducida (×" + portionMultiplier + ")"
                    : "porción estándar",
        url:            getUrl(finalRecipe)
      });

      dailyFiberSoFar += nut.fiber_g || 0;

      const detectedProtein = inferProteinSource(finalRecipe);
      if (detectedProtein) {
        if (!dailyProteinSources[dateStr]) dailyProteinSources[dateStr] = new Set();
        dailyProteinSources[dateStr].add(detectedProtein);
      }
    }
    if (!recipe) {
      // [v15] meal_miss_log: loggear slot vacío para diagnóstico
      console.warn(`[v15][MEAL_MISS] ${dateStr} slot="${mealType}" → sin receta válida (0 candidatas)`);
    }
  }

 // [v15] assert_cena: la cena debe existir siempre tras el loop
  const tieneCena = meals.some(m => m.mealType === "cena");
  if (!tieneCena) {
    console.error(`[v15][ASSERT_FAIL] ${dateStr} — cena ausente tras loop. Comprueba classification.meal_type en recetas.`);

    // Último recurso: cualquier receta de almuerzo con >300 kcal no usada hoy
    const emergencyCena = recipes.find(r => {
      const nut  = getNutricion(r);
      const slug = getSlug(r);
      const types = r.classification?.meal_type?.map(t => t.toLowerCase()) || [];
      return (types.includes("almuerzo") || types.includes("cena"))
        && nut.calories > 300
        && !Object.values(usedSlugsByMealType).some(s => s.has(slug));
    });

    if (emergencyCena) {
      const eNut  = getNutricion(emergencyCena);
      const eCal  = eNut.calories || 0;
      const eTgt  = Math.round(dailyTarget * 0.30);
      const eMult = Math.min(
        eTgt > 0 && eCal > 0 ? parseFloat((eTgt / eCal).toFixed(2)) : 1.0,
        MAX_REASONABLE_MULTIPLIER
      );
      if (!usedSlugsByMealType["cena"]) usedSlugsByMealType["cena"] = new Set();
      usedSlugsByMealType["cena"].add(getSlug(emergencyCena));

      const snackIdx = meals.findIndex(m => m.mealType === "snack");
      const eEntry = {
        mealType: "cena",
        timing:   isTrainingDay ? classifyMealTiming("cena", workoutHour) : "other",
        slug:     getSlug(emergencyCena),
        name:     getNombreReceta(emergencyCena),
        calories: eCal,
        protein:  eNut.protein_g || 0,
        carbs:    eNut.carbs_g   || 0,
        fat:      eNut.fat_g     || 0,
        fiber:    eNut.fiber_g   || null,
        nutritionScore:    getNutritionScore(emergencyCena, profile.goalNormalized),
        portionMultiplier: eMult,
        portionLabel: eMult >= 1.8 ? `porción grande (×${eMult})`
                    : eMult >= 1.2 ? `porción ampliada (×${eMult})`
                    : eMult <= 0.8 ? `porción reducida (×${eMult})`
                    : "porción estándar",
        url:            getUrl(emergencyCena),
        isEmergencyMeal: true
      };
      snackIdx !== -1 ? meals.splice(snackIdx, 0, eEntry) : meals.push(eEntry);
      console.warn(`[v15][EMERGENCY_MEAL] ${dateStr} — cena de emergencia: "${eEntry.name}"`);
    }
  }

  // [v8] MEAL DE RESCATE: si el total calórico es < 85% del target, añadir snack/merienda extra
  const provisionalTotal = meals.reduce((sum, m) => sum + (m.calories || 0), 0);
  const rescueThreshold  = dailyTarget * 0.85;

  if (provisionalTotal < rescueThreshold) {
    const calGap       = dailyTarget - provisionalTotal;
    const rescueTypes = [];
    if (!meals.some(m => m.mealType === "snack"))    rescueTypes.push("snack");
    if (!meals.some(m => m.mealType === "merienda")) rescueTypes.push("merienda");
    // Si el déficit es > 25% y no hay tipos libres, intentar un segundo snack
    if (rescueTypes.length === 0 && provisionalTotal < dailyTarget * 0.75) {
      // Buscar snack como tipo de rescate secundario con slug diferente al ya usado
      const existingSnackSlug = meals.find(m => m.mealType === "snack")?.slug;
      const secondSnackCandidates = filterRecipes(recipes, profile, "snack")
        .filter(r => getSlug(r) !== existingSnackSlug);
      if (secondSnackCandidates.length > 0) {
        rescueTypes.push("snack_secondary"); // flag interno
      } else {
        rescueTypes.push("merienda"); // fallback
      }
    }

    for (const rescueType of rescueTypes) {
      const dbMealType = rescueType === "snack_secondary" ? "snack" : rescueType;
      if (provisionalTotal >= rescueThreshold) break;

      const deficitRatio = calGap / dailyTarget;
      const rescueRatio  = deficitRatio > 0.30 ? 0.25
                        : deficitRatio > 0.20 ? 0.20
                        : 0.15;
      const rescueTarget = Math.min(calGap, Math.round(dailyTarget * rescueRatio));
      const rescueProt   = Math.round(dailyMacros.protein * 0.10);
      const todayProt    = dailyProteinSources[dateStr] || new Set();
      const recentProt   = recentProteinsByDate[dateStr] || new Set();
      const usedProt     = new Set([...todayProt, ...recentProt]);

      const rescueRecipe = selectRecipeForMeal(
        recipes, profile, dbMealType, rescueTarget, rescueProt,
        usedSlugsByMealType, "other", usedProt, false, weeklyRecipeCount,
        slugHistory, currentWeekNum
      );

      if (rescueRecipe) {
        const rNut = getNutricion(rescueRecipe);
        const rCal = rNut.calories || 0;
        const rMult = rescueTarget > 0 && rCal > 0
          ? parseFloat((rescueTarget / rCal).toFixed(2))
          : 1.0;
        // [v14] Aplicar mínimo 0.8 para rescue meals (siempre son snack/merienda)
        const rMultFinal = Math.max(0.8, Math.min(rMult, MAX_REASONABLE_MULTIPLIER));

        if (!usedSlugsByMealType[rescueType]) usedSlugsByMealType[rescueType] = new Set();
        usedSlugsByMealType[rescueType].add(getSlug(rescueRecipe));

        meals.push({
          mealType: rescueType === "snack_secondary" ? "snack_2" : rescueType,
          timing:         "other",
          slug:           getSlug(rescueRecipe),
          name:           getNombreReceta(rescueRecipe),
          calories:       rCal,
          protein:        rNut.protein_g || 0,
          carbs:          rNut.carbs_g   || 0,
          fat:            rNut.fat_g     || 0,
          fiber:          rNut.fiber_g   || null,
          nutritionScore: getNutritionScore(rescueRecipe, profile.goalNormalized),
          portionMultiplier: rMultFinal,
          portionLabel: rMultFinal >= 1.8 ? `porción grande (×${rMultFinal})`
                      : rMultFinal >= 1.2 ? `porción ampliada (×${rMultFinal})`
                      : rMultFinal <= 0.8 ? `porción reducida (×${rMultFinal})`
                      : "porción estándar",
          url:            getUrl(rescueRecipe),
          isRescueMeal:   true   // flag para que el frontend lo sepa
        });

        dailyFiberSoFar += rNut.fiber_g || 0;
        const dp = inferProteinSource(rescueRecipe);
        if (dp) {
          if (!dailyProteinSources[dateStr]) dailyProteinSources[dateStr] = new Set();
          dailyProteinSources[dateStr].add(dp);
        }
        // [v12] Actualizar weeklyRecipeCount para que rescue meals no se repitan
        const rescueSlug = getSlug(rescueRecipe);
        weeklyRecipeCount[rescueSlug] = (weeklyRecipeCount[rescueSlug] || 0) + 1;
      }
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

  const actualTotal = totals.calories;
  const warningThreshold = dailyTarget * 0.30; // medium si > 30%
  const planWarnings = [];

  if (Math.abs(actualTotal - dailyTarget) > warningThreshold) {
    planWarnings.push({
      type:     "CALORIE_DEVIATION",
      message:  `Desviación calórica del ${Math.round(Math.abs(actualTotal - dailyTarget) / dailyTarget * 100)}% respecto al objetivo`,
      severity: Math.abs(actualTotal - dailyTarget) > dailyTarget * 0.40 ? "high" : "medium",
      targetCalories: dailyTarget,
      actualCalories: actualTotal
    });
  }

  return {
    targetCalories: dailyTarget,
    targetMacros:   dailyMacros,
    actualTotals:   totals,
    calorieDeviation: totals.calories - dailyTarget,
    calorieGapToTarget: Math.max(0, dailyTarget - totals.calories),  
  coveragePercent: Math.round((totals.calories / dailyTarget) * 100), 
    recommendedWaterMl: Math.round(profile.weightKg * 35) + (isTrainingDay ? 600 : 0),
    planWarnings,
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
              reps:          typeof ex.reps === "number" ? ex.reps : null, // [v15] reps_type_fix: separar reps numéricas de duración por tiempo
              duration_seconds: typeof ex.reps === "string" && ex.reps.includes("segundo")
                                ? 45
                                : null,
              repScheme:     typeof ex.reps === "string" ? ex.reps : null,
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
              isTrainingDay: day.isTrainingDay,
              isRescueMeal:  meal.isRescueMeal || false
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
    if (day.nutrition?.planWarnings?.length) {
      day.nutrition.planWarnings.forEach(warning => {
        events.push(createEvent(
          "PLAN_WARNING",
          {
            itemId:   `${day.date}_${warning.type}`,
            itemType: "nutrition",
            context: {
              date:          day.date,
              isTrainingDay: day.isTrainingDay,
              weekNumber:    weekPlan.weekNumber
            },
            warningMetadata: warning
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

function generateWeek(profile, exercises, recipes, weekNumber, crossWeekState = {}) {
  const sessionId    = randomUUID();
  const startDateObj = new Date(profile.startDate);

  // [Q-4] Progresión semanal
  const progression = getWeeklyProgression(weekNumber);

  const trainingDays = profile.availableDays.length;
  const splitMap     = determineSplit(trainingDays);
  const splitNames   = SPLIT_NAMES[trainingDays] || ["Full Body"];

  // [FIX-3] Filtrar ejercicios solo por difficulty y equipment
    const { primary: primaryExercises, fallback: fallbackExercises } = filterExercises(exercises, profile, progression.phase);

  // Estado semanal
  const weeklyUsedSlugs      = new Set(); // siempre fresco cada semana (ejercicios)
  const usedSlugsByMealType  = crossWeekState.usedSlugsByMealType  || {};
  const dailyProteinSources  = crossWeekState.dailyProteinSources  || {};
  const recentProteinsByDate = crossWeekState.recentProteinsByDate || {};
  const musclesWorkedRecently = crossWeekState.musclesWorkedRecently || new Map();
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

      const rawAvgMet = orderedExercises.length > 0
        ? orderedExercises.reduce((sum, ex) => sum + (ex.metValue || 4), 0) / orderedExercises.length
        : 4;
      const minMetByIntensity = { low: 3.5, moderate: 4.5, high: 6.0 };
      const avgMet = Math.max(rawAvgMet, minMetByIntensity[effectiveIntensity] || 3.5);
      const volumeMultiplier = progression.phase === "intensity" ? 1.2
                            : progression.deload               ? 0.75
                            : 1.0;
      const sessionDuration = Math.round(profile.sessionDuration * volumeMultiplier);
      const durationHours = sessionDuration / 60;
      const estimatedCaloriesBurned = Math.round(avgMet * profile.weightKg * durationHours);

      workout = {
        type:       profile.trainingTypes[0] || "strength",
        splitFocus,
        duration:   progression.deload
          ? Math.round(profile.sessionDuration * 0.75)
          : profile.sessionDuration,
        estimatedCaloriesBurned,
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

    const nutrition = buildDayNutrition(recipes, profile, isTrainingDay, usedSlugsByMealType, workoutHour, dailyProteinSources, dateStr, recentProteinsByDate, progression.phase, crossWeekState.slugHistory || {}, weekNumber);
    
    // Propagar proteínas del día de hoy a los 2 días siguientes
    const todayDetected = dailyProteinSources[dateStr];
    if (todayDetected) {
      for (let offset = 1; offset <= 2; offset++) {
        const futureDate = new Date(date);
        futureDate.setDate(date.getDate() + offset);
        const futureDateStr = futureDate.toISOString().split("T")[0];
        if (!recentProteinsByDate[futureDateStr]) {
          recentProteinsByDate[futureDateStr] = new Set();
        }
        todayDetected.forEach(p => recentProteinsByDate[futureDateStr].add(p));
      }
    }

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
      generatedAt:      new Date().toISOString(),
      featuresActive: [
        "split_integrity_v8",
        "rescue_meal_v9",
        "protein_rotation_48h",
        "nutrition_score_normalized",
        "weekly_recipe_diversity_v2",
        "estimated_calories_burned",
        "muscle_recovery_48h",
        "calorie_gap_tracking",
        "portion_labels",
        "multi_week_v12",
        "fix_cena_v14",
        "fix_rescue_args_v14",
        "fix_portion_min_v14",
        "phase_exercise_filter",
        "cross_week_state",
        "min_slot_calories_v16",
        "reps_type_fix_v16",
        "diversity_v3_v16"
      ]
    },
    days
  };

  const events = generatePlanEvents(weekPlan, profile, sessionId, progression);
  return { weekPlan, events };
}

function generateMultiWeekPlan(profile, exercises, recipes, totalWeeks) {
  const allWeeks  = [];
  const allEvents = [];

  // Estado persistente entre semanas
  const crossWeekState = {
    usedSlugsByMealType:  {},
    dailyProteinSources:  {},
    recentProteinsByDate: {},
    musclesWorkedRecently: new Map()
  };

  for (let weekNum = 1; weekNum <= totalWeeks; weekNum++) {
    // Calcular startDate de esta semana
    const baseDate  = new Date(profile.startDate);
    const weekStart = new Date(baseDate);
    weekStart.setDate(baseDate.getDate() + (weekNum - 1) * 7);
    const weekStartStr = weekStart.toISOString().split("T")[0];

    // Perfil con startDate de esta semana
    const weekProfile = { ...profile, startDate: weekStartStr };

    if (!crossWeekState.slugHistory) crossWeekState.slugHistory = {}; // { slug → lastWeekUsed }

    // Registrar qué semana usó cada receta
    if (weekNum > 1) {
      Object.entries(crossWeekState.usedSlugsByMealType).forEach(([mealType, slugSet]) => {
        slugSet.forEach(slug => {
          crossWeekState.slugHistory[slug] = weekNum - 1;
        });
      });
      // Limpiar para la nueva semana
      crossWeekState.usedSlugsByMealType = {};
    }

    const { weekPlan, events } = generateWeek(
      weekProfile, exercises, recipes, weekNum, crossWeekState
    );

    // Propagar estado al siguiente ciclo
    // usedSlugsByMealType ya se actualizó dentro de generateWeek (es referencia compartida)
    // Solo necesitamos sincronizar musclesWorkedRecently del último día de la semana
    weekPlan.days.forEach(day => {
      if (day.workout?.exercises) {
        day.workout.exercises.forEach(ex => {
          crossWeekState.musclesWorkedRecently.set(ex.muscleGroup, day.date);
        });
      }
    });

    allWeeks.push(weekPlan);
    allEvents.push(...events);
  }

  return { allWeeks, allEvents };
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
  console.log(`  Sporvit Plan Engine ${VERSION} — ${TOTAL_WEEKS} semana(s)`);
  console.log(`  Inicio en semana: ${WEEK_NUMBER}`);
  console.log(`═══════════════════════════════════════\n`);

  profiles.forEach(profile => {
    console.log(`── Generando plan para ${profile.userId} (${TOTAL_WEEKS} semanas) ──`);

    const { allWeeks, allEvents: profileEvents } =
      generateMultiWeekPlan(profile, exercises, recipes, TOTAL_WEEKS);

    // ── Guardar un archivo por semana ──
    const indexEntries = [];

    allWeeks.forEach(weekPlan => {
      const weekNum  = weekPlan.weekNumber;
      const planPath = TOTAL_WEEKS === 1
        ? `./output/plan_${profile.userId}.json`
        : `./output/plan_${profile.userId}_week${weekNum}.json`;

      fs.writeFileSync(planPath, JSON.stringify(weekPlan, null, 2));
      console.log(`✓ Semana ${weekNum} guardada: ${planPath}`);

      indexEntries.push({
        weekNumber: weekNum,
        file:       path.basename(planPath),
        phase:      weekPlan.phase,
        startDate:  weekPlan.startDate,
        endDate:    weekPlan.endDate
      });

      // Warnings HIGH por semana
      const highWarnings = weekPlan.days
        .flatMap(d => d.nutrition?.planWarnings || [])
        .filter(w => w.severity === "high");
      if (highWarnings.length > 0) {
        console.warn(`  ⚠️  ${highWarnings.length} HIGH warnings en semana ${weekNum}:`);
        highWarnings.forEach(w => console.warn(`     - ${w.message}`));
      }
    });

    // ── Índice maestro (solo si multi-semana) ──
    if (TOTAL_WEEKS > 1) {
      const indexPath = `./output/plan_${profile.userId}_index.json`;
      fs.writeFileSync(indexPath, JSON.stringify({
        userId:     profile.userId,
        totalWeeks: TOTAL_WEEKS,
        generatedAt: new Date().toISOString(),
        generatorVersion: VERSION,
        weeks: indexEntries
      }, null, 2));
      console.log(`✓ Índice maestro: ${indexPath}`);
    }

    // ── Eventos ──
    const eventsPath = `./logs/events_${profile.userId}.jsonl`;
    fs.writeFileSync(eventsPath, profileEvents.map(e => JSON.stringify(e)).join("\n"));
    console.log(`✓ Eventos: ${eventsPath} (${profileEvents.length} eventos)`);
    allEvents.push(...profileEvents);

    // ── Resumen de calidad (promedio de todas las semanas) ──
    const allDays = allWeeks.flatMap(w => w.days);
    const trainingDays = allDays.filter(d => d.isTrainingDay);
    const totalExercises = trainingDays.reduce(
      (acc, d) => acc + (d.workout?.exercises?.length || 0), 0
    );
    const totalMeals = allDays.reduce(
      (acc, d) => acc + (d.nutrition?.meals?.length || 0), 0
    );
    const emptyWorkouts = trainingDays.filter(
      d => !d.workout?.exercises?.length
    ).length;
    const avgDeviation = allDays.reduce(
      (acc, d) => acc + Math.abs(d.nutrition?.calorieDeviation || 0), 0
    ) / allDays.length;
    const allSlugs = allDays.flatMap(d =>
      (d.nutrition?.meals || []).map(m => m.slug).filter(Boolean)
    );
    const uniqueSlugs  = new Set(allSlugs).size;
    const diversityPct = Math.round((uniqueSlugs / allSlugs.length) * 100);
    const warnings = allDays.flatMap(d => d.nutrition?.planWarnings || []);

    console.log(`  Semanas generadas  : ${TOTAL_WEEKS}`);
    console.log(`  Días entrenamiento : ${trainingDays.length}`);
    console.log(`  Ejercicios totales : ${totalExercises}`);
    console.log(`  Sesiones vacías    : ${emptyWorkouts} ${emptyWorkouts > 0 ? "⚠️" : "✓"}`);
    console.log(`  Comidas totales    : ${totalMeals}`);
    console.log(`  Desviación cal/día : ~${Math.round(avgDeviation)} kcal`);
    console.log(`  Recetas únicas     : ${uniqueSlugs}/${allSlugs.length} (${diversityPct}% diversidad)`);
    console.log(`  Plan warnings      : ${warnings.length} (${warnings.filter(w => w.severity === "high").length} high, ${warnings.filter(w => w.severity === "medium").length} medium)\n`);
  });

  fs.writeFileSync(
    "./logs/events_all.jsonl",
    allEvents.map(e => JSON.stringify(e)).join("\n")
  );
  console.log(`✓ Log global: ./logs/events_all.jsonl (${allEvents.length} eventos totales)`);
  console.log("\n¡Listo! Planes en ./output — Logs en ./logs\n");
}

run();