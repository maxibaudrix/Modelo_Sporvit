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

const VERSION = "v26";

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
    type:        "description",
    duration: 8,
    description: "Movilidad de cadera: círculos de cadera 2×10, sentadilla profunda asistida 2×10. Activación de glúteo: puentes de glúteo 2×15. Cardio suave 3 min (bicicleta o trote)."
  },
  "Superior + Empuje": {
    type:        "description",
    duration: 7,
    description: "Rotación de hombro (interna y externa) 2×15, movilidad torácica con foam roller 2 min, elevaciones laterales con banda 2×15. Cardio suave 3 min."
  },
  "Full Body": {
    type:        "description",
    duration: 8,
    description: "Movilidad articular completa: cuello, hombros, caderas, rodillas, tobillos (30s cada zona). Sentadilla sin peso 2×10. Cardio suave 3 min."
  },
  "Upper A": {
    type:        "description",
    duration: 7,
    description: "Rotación de hombro con banda 2×15, movilidad torácica 2 min, aperturas de pecho con banda 2×15. Cardio suave 3 min."
  },
  "Lower A": {
    type:        "description",
    duration: 8,
    description: "Activación de glúteo: clamshells 2×15, puentes 2×15. Movilidad de cadera: flexores de cadera (60s por lado). Cardio suave 3 min."
  },
  "Upper B": {
    type:        "description",
    duration: 7,
    description: "Rotación de hombro con banda 2×15, movilidad torácica 2 min, remo con banda 2×15. Cardio suave 3 min."
  },
  "Lower B": {
    type:        "description",
    duration: 8,
    description: "Activación de glúteo: monster walks con banda 2×10m. Movilidad de tobillo: círculos 2×10. Bisagra de cadera sin peso 2×10. Cardio suave 3 min."
  },
  "Push": {
    type:        "description",
    duration: 7,
    description: "Rotación interna/externa de hombro con banda 2×15. Movilidad de muñeca 1 min. Press con banda 2×15. Cardio suave 3 min."
  },
  "Pull": {
    type:        "description",
    duration: 7,
    description: "Movilidad de hombro en polea baja 2×15. Retracción escapular con banda 2×15. Movilidad torácica 2 min. Cardio suave 3 min."
  },
  "Legs": {
    type:        "description",
    duration: 8,
    description: "Puentes de glúteo 2×15, sentadilla sin peso 2×15, movilidad de tobillo 2×10. Cardio suave 3 min."
  },
  "Upper": {
    type:        "description",
    duration: 7,
    description: "Rotación de hombro con banda 2×15, aperturas de pecho 2×15, movilidad torácica 2 min. Cardio suave 3 min."
  },
  "Full Body A": {
    type:        "description",
    duration: 8,
    description: "Movilidad articular completa 3 min. Sentadilla sin peso 2×10. Rotación de hombro con banda 2×15. Cardio suave 2 min."
  },
  "Full Body B": {
    type:        "description",
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
  type:"description",
  duration: 7,
  description: "Movilidad dinámica articular completa 3 min. Activación del core: plancha 3×20s. Cardio suave 3 min."
};
const COOLDOWN_DEFAULT = {
  type:"description",
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
    "squat", "deadlift", "bench", "row", "pulldown", "lunge",
    // [v25] compound_ratio_enforcement: más keywords para reducir falsos isolation
    "empuje", "tirón", "bisagra", "tracción", "step up", "step-up",
    "bulgarian", "goblet", "swing", "clean", "snatch", "thruster",
    "pull through", "pull-through", "rdl", "buenos días", "good morning",
    "hip hinge", "split squat", "sumo", "hack squat", "leg press",
    "chest press", "shoulder press", "overhead press", "ohp",
    "inverted row", "ring row", "dip", "chin up", "chin-up", "pull up", "pull-up"
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
  const sessionUsedSlugs = new Set();
  const groupCount = {};

  // [v25] compound_ratio_enforcement: reservar al menos 1 slot para compound
  // y 1 para compound_acc antes de asignar isolation.
  // Objetivo: mínimo 30% compuestos en cualquier sesión.
  const MIN_COMPOUND_SLOTS = Math.max(1, Math.round(totalSlots * 0.30));
  const categoryCount = { compound: 0, compound_acc: 0, isolation: 0, core: 0 };
  
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

    // [v25] compound_ratio_enforcement: si aún no se han cubierto los slots
    // mínimos de compound, bloquear temporalmente isolation y core.
    const cat = inferExerciseCategory(ex);
    const compoundsFilled = categoryCount.compound + categoryCount.compound_acc;
    if (compoundsFilled < MIN_COMPOUND_SLOTS && (cat === "isolation" || cat === "core")) continue;

    selected.push(ex);
    sessionUsedSlugs.add(ex.slug);
    weeklyUsedSlugs.add(ex.slug);
    groupCount[group] = (groupCount[group] || 0) + 1;
    categoryCount[cat] = (categoryCount[cat] || 0) + 1;
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

function filterRecipes(recipes, profile, mealType) {
  const lookupType = mealType === "cena" ? ["cena", "almuerzo"] : [mealType];

  // [v20] breakfast_protein_floor: candidatas primarias con density >= 6g/100kcal
  // Si el pool resultante queda vacío, se usa el pool sin filtro (fallback)
  const BREAKFAST_MIN_DENSITY = 6.0; // g proteína / 100 kcal

  const baseFilter = r => {
    const mealOk = r.classification?.meal_type?.some(mt =>
      lookupType.includes(mt.toLowerCase())
    );
    if (!mealOk) return false;

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
  };

  const allCandidates = recipes.filter(baseFilter);

  // [v20] Para desayuno: filtrar primero por densidad mínima; si vacío, usar pool completo
  if (mealType === "desayuno") {
    const highProtein = allCandidates.filter(r => {
      const nut = getNutricion(r);
      return nut.calories > 0 && (nut.protein_g / nut.calories) * 100 >= BREAKFAST_MIN_DENSITY;
    });
    if (highProtein.length >= 3) {
      return highProtein; // pool con densidad aceptable
    }
    console.warn(`[v20][BREAKFAST_FLOOR] Pool de desayuno proteico insuficiente (${highProtein.length} recetas ≥${BREAKFAST_MIN_DENSITY}g/100kcal). Usando pool completo.`);
    return allCandidates; // fallback: sin restricción
  }

  return allCandidates;
}

/**
 * [Q-8] Calcula score compuesto para ranking de recetas.
 * Combina nutrition_score del objetivo, cercanía calórica,
 * timing (pre/post/other), y proteína mínima del slot.
 */
  function scoreRecipe(recipe, goalKey, targetCalories, targetProtein, timingWeights, usedProteins = new Set(), fiberNeeded = false, weeklyRecipeCount = {}, slugHistory = {}, currentWeekNum = 1, profile = null, proteinBudgetRemaining = 999, targetFat = 0) {
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
  const proteinBonus  = proteinRatio >= 0.8 ? 1.0 : proteinRatio;

  // [v19] protein_target_enforcement: penalizar recetas con densidad proteica muy baja
  // (< 10g proteína por cada 100 kcal). Evita que el upscale cubra calorías a base de carbos/grasa.
  const proteinDensity = calories > 0 ? (protein / calories) * 100 : 0; // g prot / 100 kcal
  const lowProteinPenalty = proteinDensity < 5  ? -3.0   // muy baja: < 5g/100kcal (ej. batido de plátano)
                          : proteinDensity < 8  ? -1.5   // baja: 5-8g/100kcal
                          : proteinDensity < 10 ? -0.5   // algo baja: 8-10g/100kcal
                          : 0;                            // aceptable: >= 10g/100kcal

  // Timing: ajusta el peso relativo de macros
  const { carbsWeight, proteinWeight, fatWeight } = timingWeights;
  const carbsScore = (nut.carbs_g  || 0) / 50 * carbsWeight;
  const protScore  = (nut.protein_g || 0) / 40 * proteinWeight;
  const fatScore   = (1 - (nut.fat_g || 0) / 30) * fatWeight;

  const timingScore = (carbsScore + protScore + fatScore) / (carbsWeight + proteinWeight + fatWeight);

  // Penalizar si la proteína principal ya se usó hoy
  const proteinSource = inferProteinSource(recipe);
  const proteinPenalty = proteinSource && usedProteins.has(proteinSource) ? -1.5 : 0;

  // [v19] allergen_score_penalty: penalizar recetas con ingredientes "preferir evitar"
  // No excluyen la receta (eso lo hace filterRecipes con allergies), solo bajan su score.
  const softAvoid = profile?.softAvoidIngredients || [];
  let softAvoidPenalty = 0;
  if (softAvoid.length > 0) {
    const ingredientText = (
      recipe.recipeIngredient ||
      recipe.localization?.es?.recipeIngredient || []
    ).join(" ").toLowerCase();
    const allergenText = (recipe.allergens?.contains || []).join(" ").toLowerCase();
    const combined = ingredientText + " " + allergenText;
    const matchCount = softAvoid.filter(a => combined.includes(a.toLowerCase())).length;
    softAvoidPenalty = matchCount > 0 ? -(matchCount * 3.0) : 0;
  }

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

  // [v23] protein_ceiling_scoring: penalizar si la receta aportaría más proteína
  // de la que queda en el presupuesto diario (120% del target proteico).
  // Evita elegir una receta de 92g proteína cuando el día ya tiene 80g acumulados.
  const proteinOverBudgetPenalty = protein > proteinBudgetRemaining * 1.5 ? -2.0
                                 : protein > proteinBudgetRemaining * 1.2 ? -1.0
                                 : 0;
  // [v26] fat_deficit_scoring: penaliza tanto exceso como déficit de grasa.
  // El déficit es el problema real (20/28 días en v25 con fat<80% del target).
  // Peso bajo (0.3) para no desplazar proteína como criterio principal.
  const fat = nut.fat_g || 0;
  const fatDiff = targetFat > 0 ? Math.abs(fat - targetFat) / targetFat : 0;
  const fatPenalty = -(fatDiff * 0.3);  // penaliza en ambas direcciones
  
  return (
    nutritionScore * 2.0 +
    (1 - calPenalty) * 1.0 +
    proteinBonus * 1.0 +
    timingScore * 0.5 +
    proteinPenalty +
    fiberBonus +
    repetitionPenalty +
    crossWeekPenalty +
    lowProteinPenalty +
    softAvoidPenalty  +
    proteinOverBudgetPenalty +  // [v23] 
    fatPenalty              // [v25]
  );
}

function selectRecipeForMeal(recipes, profile, mealType, targetCalories, targetProtein, usedSlugsByMealType, mealTiming, usedProteins = new Set(), fiberNeeded = false, weeklyRecipeCount = {}, slugHistory = {}, currentWeekNum = 1, usedSlugsToday = new Set(), proteinBudgetRemaining = 999, targetFat = 0) {
const goalKey    = profile.goalNormalized;
  const candidates = filterRecipes(recipes, profile, mealType);
  if (!candidates.length) return null;

  const usedForMeal   = usedSlugsByMealType[mealType] || new Set();
  const usedSlugsArr  = [...usedForMeal];
  const lastUsedSlug  = usedSlugsArr[usedSlugsArr.length - 1]; // la más reciente

  // Nivel 1: nunca usada esta semana NI hoy en otro slot [v22]
  const fresh = candidates.filter(r => !usedForMeal.has(getSlug(r)) && !usedSlugsToday.has(getSlug(r)));

  // Nivel 2: pool agotado — al menos evitar la última usada
  const avoidLast = candidates.filter(r => getSlug(r) !== lastUsedSlug);

  // Nivel 3: rendirse, usar todo el pool
  const pool = fresh.length > 0 ? fresh
             : avoidLast.length > 0 ? avoidLast
             : candidates;

  const timingWeights = getTimingRequirements(mealTiming);
  const sorted = [...pool].sort((a, b) =>
    scoreRecipe(b, goalKey, targetCalories, targetProtein, timingWeights, usedProteins, fiberNeeded, weeklyRecipeCount, slugHistory, currentWeekNum, profile, proteinBudgetRemaining, targetFat) -
    scoreRecipe(a, goalKey, targetCalories, targetProtein, timingWeights, usedProteins, fiberNeeded, weeklyRecipeCount, slugHistory, currentWeekNum, profile, proteinBudgetRemaining, targetFat)
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

function buildDayNutrition(recipes, profile, isTrainingDay, usedSlugsByMealType, workoutHour, dailyProteinSources, dateStr, recentProteinsByDate, phase = "base", slugHistory = {}, currentWeekNum = 1, calorieSurplusFromPrev = 0, consecutiveSmoothingDays = 0) {
  const deloadCalorieReduction = (phase === "deload") ? 0.90 : 1.0;
  const baseTarget = isTrainingDay
    ? Math.round(profile.calculations.trainingDayCalories * deloadCalorieReduction)
    : Math.round(profile.calculations.restDayCalories    * deloadCalorieReduction);

  // [v21] smoothing_dampening: cap reducido (6%) y máximo 2 días consecutivos
  // para evitar el círculo vicioso: surplus → target reducido → nuevo surplus
  const SMOOTHING_CAP_PCT  = 0.06;  // de 0.10 a 0.06
  const MAX_SMOOTHING_DAYS = 2;     // máximo días consecutivos con reducción
  const smoothingAdjustment = calorieSurplusFromPrev > 0 && consecutiveSmoothingDays < MAX_SMOOTHING_DAYS
    ? -Math.min(Math.round(calorieSurplusFromPrev * 0.5), Math.round(baseTarget * SMOOTHING_CAP_PCT))
    : 0;
  const dailyTarget = baseTarget + smoothingAdjustment;
  if (smoothingAdjustment !== 0) {
    console.log(`[v21][SMOOTHING] ${dateStr} — target ${baseTarget}→${dailyTarget} kcal (superávit previo: ${calorieSurplusFromPrev} kcal, día consecutivo: ${consecutiveSmoothingDays + 1}/${MAX_SMOOTHING_DAYS})`);
  }
  if (smoothingAdjustment === 0 && calorieSurplusFromPrev > 0) {
    console.log(`[v21][SMOOTHING_SKIP] ${dateStr} — smoothing omitido (${consecutiveSmoothingDays} días consecutivos, cap alcanzado)`);
  }

  const dailyMacros = computeDailyMacros(profile, isTrainingDay);

  // [v15] orden canónico garantizado: desayuno → almuerzo → cena → snack
  const mealTypes = profile.mealsPerDay >= 4
    ? ["desayuno", "almuerzo", "cena", "snack"]
    : ["desayuno", "almuerzo", "cena"];

  const meals = [];
  // [v17] per_slot_multiplier_cap: caps diferenciados por tipo de slot
  // [v23] deload_multiplier_cap: en fase deload los caps bajan para adaptarse
  // al target reducido (10% menos) sin sobreescalar recetas de calorías base alta.
  const MULTIPLIER_CAP_BY_MEAL = phase === "deload"
    ? { desayuno: 1.3, almuerzo: 2.0, cena: 2.0, snack: 1.2, merienda: 1.2 }
    : { desayuno: 1.6, almuerzo: 2.5, cena: 2.5, snack: 1.4, merienda: 1.4 };

  const MAX_REASONABLE_MULTIPLIER = 2.5; // solo se usa como fallback global
  let dailyFiberSoFar = 0;

  // [v7] Conteo de slugs usados esta semana en todos los tipos de comida
  const weeklyRecipeCount = {};
  Object.values(usedSlugsByMealType).forEach(slugSet => {
    slugSet.forEach(slug => {
      weeklyRecipeCount[slug] = (weeklyRecipeCount[slug] || 0) + 1;
    });
  });

  for (const mealType of mealTypes) {
    // [v23] prospective_budget_check: en días de descanso con mealsPerDay<4,
    // verificar si AÑADIR este slot haría superar el target antes de asignarlo.
    // Reemplaza el check reactivo de v22 (que usaba running total ya acumulado)
    // por uno prospectivo que simula el impacto del slot antes de asignarlo.
    if (!isTrainingDay && profile.mealsPerDay < 4
        && (mealType === 'snack' || mealType === 'merienda')) {
      const runningTotal  = meals.reduce((s, m) => s + (m.calories || 0), 0);
      const slotEstimate  = Math.round(dailyTarget * (MEAL_CALORIE_SPLIT[mealType] || 0.10));
      const projectedTotal = runningTotal + slotEstimate;
      if (projectedTotal > dailyTarget * 1.03) {
        console.log(`[v23][PROSPECTIVE_CAP] ${dateStr} ${mealType} omitido — proyectado ${projectedTotal} > ${Math.round(dailyTarget * 1.03)} (target ${dailyTarget})`);
        continue;
      }
    }
    const split      = MEAL_CALORIE_SPLIT[mealType] || 0.25;
    const targetCal  = Math.round(dailyTarget * split);
    const targetProt = Math.round(dailyMacros.protein * split * 1.1);
    // [v25] fat_macro_scoring: pasar target de grasa del slot al selector
    const targetFat  = Math.round(dailyMacros.fat * split);

    const timing = isTrainingDay
      ? classifyMealTiming(mealType, workoutHour)
      : "other";

    const todayProteins   = dailyProteinSources[dateStr] || new Set();
    const recentProteins  = recentProteinsByDate[dateStr] || new Set();
    const usedProteins    = new Set([...todayProteins, ...recentProteins]);
    const fiberNeeded  = dailyFiberSoFar < 25;

    // [v23] protein_ceiling_scoring: pasar proteína acumulada hoy para penalizar
    // recetas que sobrepasarían el techo diario (120% del target).
    const proteinSoFar = meals.reduce((s, m) => s + (m.protein || 0), 0);
    const proteinBudgetRemaining = Math.max(0, dailyMacros.protein * 1.2 - proteinSoFar);

    // [v22] diversity_cross_slot: excluir slugs ya asignados hoy en cualquier slot.
    // Evita que almuerzo y cena reciban la misma receta el mismo día.
    const usedSlugsToday = new Set(meals.map(m => m.slug).filter(Boolean));
    
    const recipe = selectRecipeForMeal(
      recipes, profile, mealType, targetCal, targetProt,
      usedSlugsByMealType, timing, usedProteins, fiberNeeded, weeklyRecipeCount,
      slugHistory, currentWeekNum, usedSlugsToday, proteinBudgetRemaining, targetFat  // [v25]
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

      const slotCap = MULTIPLIER_CAP_BY_MEAL[mealType] ?? MAX_REASONABLE_MULTIPLIER;
      if (portionMultiplier > slotCap) {
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
            return m <= slotCap && m >= 0.7;
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

  // [v17] calorie_gap_upscale: si tras el loop normal el gap es >15%, 
  // intentar escalar en sitio los slots de almuerzo y cena antes del rescue meal.
  // Solo se aplica cuando la BD tiene recetas con calorías insuficientes (situación estructural).
  const gapAfterLoop = dailyTarget - meals.reduce((s, m) => s + (m.calories || 0), 0);
  const gapRatio = gapAfterLoop / dailyTarget;

  if (gapRatio > 0.15) {
    const UPSCALE_SLOTS = ["almuerzo", "cena"];
    const maxUpscaleCap = 2.8; // límite absoluto de seguridad, nunca superar esto
    let remainingGap = gapAfterLoop;

    for (const slot of UPSCALE_SLOTS) {
      if (remainingGap <= 0) break;
      const mealIdx = meals.findIndex(m => m.mealType === slot);
      if (mealIdx === -1) continue;

      const meal = meals[mealIdx];
      const currentCalories = meal.calories || 0;
      if (currentCalories <= 0) continue;

      const currentMult = meal.portionMultiplier || 1.0;
      const slotCap     = MULTIPLIER_CAP_BY_MEAL[slot] ?? 2.5;
      if (currentMult >= slotCap) continue;

      // [v20] protein_aware_upscale: si la receta asignada tiene baja densidad proteica
      // y el gap es significativo (>200 kcal), intentar sustituirla por una con mejor ratio
      // antes de escalar. Solo sustituir si existe alternativa con density >= 10g/100kcal.
      const currentDensity = currentCalories > 0 ? (meal.protein / currentCalories) * 100 : 0;
      if (currentDensity < 8 && remainingGap > 200) {
        const slotTarget    = Math.round(currentCalories + remainingGap * (slot === "almuerzo" ? 0.65 : 0.35));
        const usedThisSlot  = usedSlugsByMealType[slot] || new Set();

        const betterCandidates = filterRecipes(recipes, profile, slot)
          .filter(r => {
            const slug = getSlug(r);
            if (slug === meal.slug) return false;
            if (usedThisSlot.has(slug)) return false;
            const n = getNutricion(r);
            if (!n.calories || n.calories <= 0) return false;
            const density = (n.protein_g || 0) / n.calories * 100;
            const mult    = slotTarget / n.calories;
            return density >= 10 && mult <= slotCap;
          })
          .sort((a, b) =>
            // [v21] protein_swap_diversity: usar scoreRecipe en lugar de cercanía calórica pura
            // para aplicar penalizaciones de repetición cross-week y diversidad
            scoreRecipe(b, profile.goalNormalized, slotTarget, Math.round(slotTarget * 0.35),
              getTimingRequirements("other"), new Set(), false,
              weeklyRecipeCount, slugHistory, currentWeekNum, profile)
            - scoreRecipe(a, profile.goalNormalized, slotTarget, Math.round(slotTarget * 0.35),
              getTimingRequirements("other"), new Set(), false,
              weeklyRecipeCount, slugHistory, currentWeekNum, profile)
          );

        if (betterCandidates.length > 0) {
          const replacement = betterCandidates[0];
          const rNut  = getNutricion(replacement);
          const rCal  = rNut.calories || 0;
          const rMult = parseFloat(Math.min(slotTarget / rCal, slotCap).toFixed(2));
          const rActualCal = Math.round(rCal * rMult);

          // Actualizar usedSlugsByMealType: quitar slug anterior, añadir nuevo
          usedSlugsByMealType[slot]?.delete(meal.slug);
          if (!usedSlugsByMealType[slot]) usedSlugsByMealType[slot] = new Set();
          usedSlugsByMealType[slot].add(getSlug(replacement));

          meals[mealIdx] = {
            ...meal,
            slug:             getSlug(replacement),
            name:             getNombreReceta(replacement),
            calories:         rActualCal,
            protein:          Math.round((rNut.protein_g || 0) * rMult),
            carbs:            Math.round((rNut.carbs_g   || 0) * rMult),
            fat:              Math.round((rNut.fat_g     || 0) * rMult),
            fiber:            rNut.fiber_g ? Math.round(rNut.fiber_g * rMult) : null,
            nutritionScore:   getNutritionScore(replacement, profile.goalNormalized),
            portionMultiplier: rMult,
            portionLabel: rMult >= 1.8 ? `porción grande (×${rMult})`
                        : rMult >= 1.2 ? `porción ampliada (×${rMult})`
                        : rMult <= 0.8 ? `porción reducida (×${rMult})`
                        : "porción estándar",
            url:              getUrl(replacement),
            isUpscaled:       true,
            wasProteinSwapped: true  // [v20] flag de trazabilidad
          };

          const savedGap = currentCalories - rActualCal; // puede ser negativo si nueva receta tiene más cal
          remainingGap -= (rActualCal - currentCalories); // restar las calorías que ya añadimos
          console.warn(`[v20][PROTEIN_SWAP] ${dateStr} ${slot} — sustituida "${meal.name}" (${currentDensity.toFixed(1)}g/100kcal) por "${getNombreReceta(replacement)}" ((${((rNut.protein_g||0)/rCal*100).toFixed(1)}g/100kcal) ×${rMult}`);
          continue; // saltar el upscale normal para este slot
        }
      }

      // Sin sustituto disponible: upscale normal (igual que v19)
      const maxExtraCalories = Math.round(currentCalories * (Math.min(slotCap, maxUpscaleCap) - currentMult));
      if (maxExtraCalories <= 0) continue;

      const extraToAdd     = Math.min(remainingGap, maxExtraCalories);
      const newCalories    = currentCalories + extraToAdd;
      const newMult        = parseFloat((currentMult + extraToAdd / currentCalories).toFixed(2));
      const clampedNewMult = Math.min(newMult, maxUpscaleCap);

      meals[mealIdx] = {
        ...meal,
        calories:          newCalories,
        portionMultiplier: clampedNewMult,
        portionLabel: clampedNewMult >= 1.8 ? `porción grande (×${clampedNewMult})`
                    : clampedNewMult >= 1.2 ? `porción ampliada (×${clampedNewMult})`
                    : clampedNewMult <= 0.8 ? `porción reducida (×${clampedNewMult})`
                    : "porción estándar",
        isUpscaled: true
      };

      remainingGap -= extraToAdd;
      console.warn(`[v17][UPSCALE] ${dateStr} ${slot} ×${currentMult}→×${clampedNewMult} (+${extraToAdd} kcal). Gap restante: ${Math.round(remainingGap)} kcal`);
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

  // [v8] MEAL DE RESCATE: si el total calórico es < umbral del target, añadir snack/merienda extra
  const provisionalTotal = meals.reduce((sum, m) => sum + (m.calories || 0), 0);
  // [v25] adaptive_rescue_threshold: umbral dinámico que elimina la zona muerta
  // entre 85% y 92% en días de entrenamiento.
  // Training: rescue si <92% (sube de 85%), cap a 97% (sube de 92%).
  // Rest: rescue si <90%, cap a 97% (sin cambio).
  const rescueThreshold = isTrainingDay
    ? dailyTarget * 0.92   // [v25] de 0.85 a 0.92 — rescue activo hasta 92%
    : dailyTarget * 0.90;

  // [v22] adaptive_meal_cap diferenciado por tipo de día.
  const CAP_PCT = isTrainingDay ? 0.97 : 0.97;  // [v25] training sube de 0.92 a 0.97
  const mealCapReached = provisionalTotal >= dailyTarget * CAP_PCT;
  if (mealCapReached) {
    console.log(`[v25][MEAL_CAP] ${dateStr} — rescue omitido: ${provisionalTotal}/${dailyTarget} kcal (${Math.round(provisionalTotal/dailyTarget*100)}% cubierto)`);
  }

  if (provisionalTotal < rescueThreshold && !mealCapReached) {
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

      // [v24] rescue_gap_aware: recalcular total real antes de cada rescue slot.
      // Evita añadir merienda cuando el snack ya cerró el gap.
      const currentTotalRescue = meals.reduce((s, m) => s + (m.calories || 0), 0);
      if (currentTotalRescue >= rescueThreshold) break;
      const calGap = dailyTarget - currentTotalRescue;  // recalculado con total actualizado

      // [v24] rescue_single_slot_cap: si el gap ya es pequeño (<15% del target),
      // no añadir más de 1 rescue slot. Evita que snack+merienda sumen 640kcal
      // cuando el déficit real era solo 190kcal.
      if (calGap < dailyTarget * 0.15 && rescueTypes.indexOf(rescueType) > 0) {
        console.log(`[v24][RESCUE_CAP] ${dateStr} ${rescueType} omitido — gap residual ${calGap}kcal < 15% del target`);
        break;
      }

      // [v26] rescue_calorie_aware: verificar si añadir este rescue haría superar
      // el target calórico. Si el gap es menor que la porción mínima de un snack,
      // el rescue produciría surplus — omitirlo.
      const minRescueCal = Math.round(MULTIPLIER_CAP_BY_MEAL['snack'] * 200); // estimado mínimo ~280kcal
      if (calGap < minRescueCal * 0.6) {
        console.log(`[v26][RESCUE_CALORIE] ${dateStr} ${rescueType} omitido — gap ${calGap}kcal < mínimo viable ${Math.round(minRescueCal * 0.6)}kcal`);
        break;
      }

      // [v26] protein_ceiling_in_rescue: verificar que el rescue no hará superar
      // el 120% del target proteico diario.
      const proteinSoFarRescue = meals.reduce((s, m) => s + (m.protein || 0), 0);
      const proteinBudgetRescue = Math.max(0, dailyMacros.protein * 1.2 - proteinSoFarRescue);
      if (proteinBudgetRescue < 5) {
        console.log(`[v26][PROTEIN_CEILING_RESCUE] ${dateStr} ${rescueType} omitido — presupuesto proteico agotado (${Math.round(proteinSoFarRescue)}g/${dailyMacros.protein}g)`);
        break;
      }

      const deficitRatio = calGap / dailyTarget;
      const rescueRatio  = deficitRatio > 0.30 ? 0.25
                        : deficitRatio > 0.20 ? 0.20
                        : 0.15;
      const rescueTarget = Math.min(calGap, Math.round(dailyTarget * rescueRatio));
      const rescueProt   = Math.round(dailyMacros.protein * 0.10);
      const todayProt    = dailyProteinSources[dateStr] || new Set();
      const recentProt   = recentProteinsByDate[dateStr] || new Set();
      const usedProt     = new Set([...todayProt, ...recentProt]);

      // [v24] cross_slot_in_rescue: evitar que el rescue asigne el mismo slug
      // que ya tienen desayuno/almuerzo/cena ese día.
      const usedSlugsTodayRescue = new Set(meals.map(m => m.slug).filter(Boolean));

      const rescueRecipe = selectRecipeForMeal(
        recipes, profile, dbMealType, rescueTarget, rescueProt,
        usedSlugsByMealType, "other", usedProt, false, weeklyRecipeCount,
        slugHistory, currentWeekNum, usedSlugsTodayRescue  // [v24]
      );

      if (rescueRecipe) {
        const rNut = getNutricion(rescueRecipe);
        const rCal = rNut.calories || 0;
        const rMult = rescueTarget > 0 && rCal > 0
          ? parseFloat((rescueTarget / rCal).toFixed(2))
          : 1.0;
        // [v14] Aplicar mínimo 0.8 para rescue meals (siempre son snack/merienda)
        const rMultFinal = Math.max(0.8, Math.min(rMult, MULTIPLIER_CAP_BY_MEAL[rescueType] ?? 1.4));

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

  // [v19] protein_target_enforcement: warning si la proteína del día queda < 80% del target
  const actualProtein = totals.protein;
  const proteinTarget = dailyMacros.protein;
  const proteinCoverage = proteinTarget > 0 ? actualProtein / proteinTarget : 1;
  if (proteinCoverage < 0.80) {
    planWarnings.push({
      type:           "PROTEIN_DEFICIT",
      message:        `Déficit proteico del ${Math.round((1 - proteinCoverage) * 100)}%: ${Math.round(actualProtein)}g vs objetivo ${proteinTarget}g`,
      severity:       proteinCoverage < 0.65 ? "high" : "medium",
      targetProtein:  proteinTarget,
      actualProtein:  Math.round(actualProtein),
      coveragePct:    Math.round(proteinCoverage * 100)
    });
  }
  // [v22] protein_surplus_warning: alerta si proteína supera 130% del target
  if (proteinCoverage > 1.30) {
    planWarnings.push({
      type:          "PROTEIN_SURPLUS",
      message:       `Exceso proteico del ${Math.round((proteinCoverage-1)*100)}%: ${Math.round(actualProtein)}g vs objetivo ${proteinTarget}g`,
      severity:      "low",
      targetProtein: proteinTarget,
      actualProtein: Math.round(actualProtein),
      surplusPct:    Math.round(proteinCoverage * 100)
    });
  }
  // [v25] hydration_by_phase
  const hydrationBase  = phase === "intensity" ? 40 : phase === "deload" ? 33 : 35;
  const hydrationExtra = isTrainingDay ? (phase === "intensity" ? 800 : 600) : 0;
  return {
    targetCalories: dailyTarget,
    targetMacros:   dailyMacros,
    actualTotals:   totals,
    calorieDeviation: totals.calories - dailyTarget,
    calorieGapToTarget: Math.max(0, dailyTarget - totals.calories),  
    coveragePercent: Math.round((totals.calories / dailyTarget) * 100), 
    recommendedWaterMl: Math.round(profile.weightKg * hydrationBase) + hydrationExtra,
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

  // ─────────────────────────────────────────────
  // [v18] WARMUP / COOLDOWN EXERCISE POOL
  // ─────────────────────────────────────────────

  /**
   * Selecciona ejercicios de warmup o cooldown desde la BD.
   * Filtra por role === "warmup" | "cooldown", equipment del perfil,
   * y splitFocus para que sean relevantes al grupo muscular del día.
   *
   * Si la BD no tiene suficientes ejercicios con ese role,
   * devuelve null y el engine usa el texto descriptivo como fallback.
   */
  function selectWarmupCooldownPool(exercises, role, splitFocus, profile, count = 4, usedSlugs = new Set()) {
    // Grupos musculares relacionados con cada split para priorizar relevancia
    const SPLIT_MUSCLE_RELEVANCE = {
      "Push":      ["chest", "shoulders", "triceps"],
      "Pull":      ["back", "biceps", "forearms"],
      "Legs":      ["legs", "glutes", "calves"],
      "Full Body": ["chest", "back", "legs", "shoulders", "core"],
      "Upper":     ["chest", "back", "shoulders", "biceps", "triceps"],
      "Lower":     ["legs", "glutes", "calves"],
      "Core":      ["core", "abs"],
    };

    const relevantMuscles = SPLIT_MUSCLE_RELEVANCE[splitFocus] || [];
    const userEquipment   = (profile.equipment || []).map(e => e.toLowerCase());

    const pool = exercises.filter(ex => {
      if (ex.role !== role) return false;
      if (!ex.isActive) return false;
      if (usedSlugs.has(ex.slug)) return false;

      // Filtro de equipment: si el ejercicio requiere algo que el usuario no tiene, excluir
      // "Ninguno" siempre se acepta
      const exEquipment = (ex.equipment || []).map(e => e.toLowerCase());
      const needsSpecific = exEquipment.filter(e => e !== "ninguno");
      if (needsSpecific.length > 0 && userEquipment.length > 0) {
        const hasEquipment = needsSpecific.some(e =>
          userEquipment.some(ue => ue.includes(e) || e.includes(ue))
        );
        if (!hasEquipment) return false;
      }

      return true;
    });

    // [v19] Si el pool filtrado queda vacío tras excluir usados, resetear y usar todos
    const effectivePool = pool.length >= count ? pool : exercises.filter(ex => {
      if (ex.role !== role) return false;
      if (!ex.isActive) return false;
      return true;
    });

    if (effectivePool.length === 0) return null;

    // Priorizar los relevantes al split del día, luego el resto
    const relevant = effectivePool.filter(ex =>
      relevantMuscles.includes((ex.muscleGroup || "").toLowerCase())
    );
    const others = effectivePool.filter(ex =>
      !relevantMuscles.includes((ex.muscleGroup || "").toLowerCase())
    );

    const ordered = [...relevant, ...others];
    const selected = ordered.slice(0, count);

    return selected.map(ex => ({
      slug:             ex.slug,
      name:             ex.nameEs || ex.name || ex.slug,
      muscleGroup:      ex.muscleGroup,
      sets:             ex.sets    ?? 2,
      reps:             typeof ex.reps === "string" && !ex.reps.includes("s") ? parseInt(ex.reps) : null,
      duration_seconds: typeof ex.reps === "string" && ex.reps.includes("s")
                          ? parseInt(ex.reps) * 1  // "30s" → 30
                          : null,
      repScheme:        typeof ex.reps === "string" ? ex.reps : null,
      imageUrl:         ex.imageUrl || null,
      role,
    }));
  }

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
  let prevDaySurplus = 0;          // [v18] cross_day_calorie_smoothing
  let consecutiveSmoothingDays = 0; // [v21] smoothing_dampening: evitar reducción encadenada

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

      // [v19] warmup_diversity: inicializar sets de rotación cross-week si no existen
      if (!crossWeekState.usedWarmupSlugs)   crossWeekState.usedWarmupSlugs   = new Set();
      if (!crossWeekState.usedCooldownSlugs) crossWeekState.usedCooldownSlugs = new Set();

      // [v18+v19] warmup_exercise_pool + warmup_diversity: ejercicios reales de BD, rotando cross-week
      const warmupPool = selectWarmupCooldownPool(exercises, "warmup", splitFocus, profile, 4, crossWeekState.usedWarmupSlugs);
      if (warmupPool) warmupPool.forEach(ex => crossWeekState.usedWarmupSlugs.add(ex.slug));
      const warmup = warmupPool
        ? {
            type:      "exercise_pool",
            duration:  7,
            exercises: warmupPool,
          }
        : (WARMUP_BY_SPLIT[splitFocus] || WARMUP_DEFAULT);  // fallback texto

      // [v18+v19] cooldown_exercise_pool + warmup_diversity: ídem para cooldown
      const cooldownPool = selectWarmupCooldownPool(exercises, "cooldown", splitFocus, profile, 4, crossWeekState.usedCooldownSlugs);
      if (cooldownPool) cooldownPool.forEach(ex => crossWeekState.usedCooldownSlugs.add(ex.slug));
      const cooldown = cooldownPool
        ? {
            type:      "exercise_pool",
            duration:  8,
            exercises: cooldownPool,
          }
        : (COOLDOWN_BY_SPLIT[splitFocus] || COOLDOWN_DEFAULT);  // fallback texto

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

      // [v18] estimated_macros_burned
      // Proteína catabolizada: ~0.15 g/kg en sesiones moderadas, escala con intensidad
      const proteinCatFactor = effectiveIntensity === "high" ? 0.20
                             : effectiveIntensity === "low"  ? 0.10
                             : 0.15;
      const proteinCatabolizedG  = parseFloat((profile.weightKg * proteinCatFactor).toFixed(1));
      // Carbohidratos oxidados: MET * duración_h * 0.6 (aprox g/min de glucógeno a intensidad moderada)
      const carbsOxidizedG = Math.round(avgMet * durationHours * 60 * 0.15);

      workout = {
        type:       profile.trainingTypes[0] || "strength",
        splitFocus,
        duration:   progression.deload
          ? Math.round(profile.sessionDuration * 0.75)
          : profile.sessionDuration,
        estimatedCaloriesBurned,
        proteinCatabolizedG,    
        carbsOxidizedG,         
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
      recipes, profile, isTrainingDay, usedSlugsByMealType, workoutHour,
      dailyProteinSources, dateStr, recentProteinsByDate,
      progression.phase, crossWeekState.slugHistory || {}, weekNumber,
      prevDaySurplus, consecutiveSmoothingDays  // [v21]
    );

    // [v21] smoothing_dampening: actualizar surplus y contador de días consecutivos
    const todaySurplus = Math.max(0, nutrition.actualTotals.calories - nutrition.targetCalories);
    prevDaySurplus = todaySurplus;
    consecutiveSmoothingDays = todaySurplus > 0 ? consecutiveSmoothingDays + 1 : 0;
    
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
        "diversity_v3_v16",
        "per_slot_multiplier_cap_v17",
        "calorie_gap_upscale_v17",
        "phase_summary_log_v17",
        "warmup_exercise_pool_v18",
        "cooldown_exercise_pool_v18",
        "estimated_macros_burned_v18",
        "cross_day_calorie_smoothing_v18",
        "protein_target_enforcement_v19",
        "allergen_score_penalty_v19",
        "warmup_diversity_v19",
        "protein_aware_upscale_v20",
        "rest_day_rescue_threshold_v20",
        "breakfast_protein_floor_v20",
        "meal_count_cap_v21",
        "smoothing_dampening_v21",
        "protein_swap_diversity_v21",
        "adaptive_meal_cap_v22",
        "mealtype_loop_budget_check_v22",
        "protein_surplus_warning_v22",
        "diversity_cross_slot_v22",
        "prospective_budget_check_v23",
        "deload_multiplier_cap_v23",
        "protein_ceiling_scoring_v23",
        "rescue_gap_aware_v24",
        "rescue_single_slot_cap_v24",
        "cross_slot_in_rescue_v24",
        "compound_ratio_enforcement_v25",
        "adaptive_rescue_threshold_v25",
        "fat_macro_scoring_v25",
        "protein_ceiling_in_rescue_v26",
        "rescue_calorie_aware_v26",
        "fat_deficit_scoring_v26"  
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
    const trainingDays  = allDays.filter(d =>  d.isTrainingDay);
    const restDays      = allDays.filter(d => !d.isTrainingDay);
    const totalExercises = trainingDays.reduce(
      (acc, d) => acc + (d.workout?.exercises?.length || 0), 0
    );
    const totalMeals = allDays.reduce(
      (acc, d) => acc + (d.nutrition?.meals?.length || 0), 0
    );
    const emptyWorkouts = trainingDays.filter(
      d => !d.workout?.exercises?.length
    ).length;

    // [v17] phase_summary_log: desglosar desviación por tipo de día y por fase
    const avgDevAll  = allDays.reduce(
      (acc, d) => acc + Math.abs(d.nutrition?.calorieDeviation || 0), 0
    ) / allDays.length;
    const avgDevTrain = trainingDays.length > 0
      ? trainingDays.reduce((acc, d) => acc + Math.abs(d.nutrition?.calorieDeviation || 0), 0) / trainingDays.length
      : 0;
    const avgDevRest  = restDays.length > 0
      ? restDays.reduce((acc, d) => acc + Math.abs(d.nutrition?.calorieDeviation || 0), 0) / restDays.length
      : 0;

    // Desglose por fase del ciclo
    const phases = ["base", "volume", "intensity", "deload"];
    const phaseStats = phases.map(phase => {
      const pDays = allDays.filter(d => {
        const week = allWeeks.find(w => w.days.some(wd => wd.date === d.date));
        return week?.phase === phase;
      });
      if (!pDays.length) return null;
      const avg = pDays.reduce((acc, d) => acc + Math.abs(d.nutrition?.calorieDeviation || 0), 0) / pDays.length;
      return { phase, avg: Math.round(avg), n: pDays.length };
    }).filter(Boolean);

    // Porciones extremas
    const extremePortions = allDays.flatMap(d =>
      (d.nutrition?.meals || []).filter(m => (m.portionMultiplier || 1) > 1.8)
    ).length;
    const upscaledMeals = allDays.flatMap(d =>
      (d.nutrition?.meals || []).filter(m => m.isUpscaled)
    ).length;

    const allSlugs = allDays.flatMap(d =>
      (d.nutrition?.meals || []).map(m => m.slug).filter(Boolean)
    );
    const uniqueSlugs  = new Set(allSlugs).size;
    const diversityPct = Math.round((uniqueSlugs / allSlugs.length) * 100);
    const warnings = allDays.flatMap(d => d.nutrition?.planWarnings || []);
    // [v19] protein_target_enforcement: métricas proteicas
    const allProteinDevs = allDays.map(d => {
      const target = d.nutrition?.targetMacros?.protein || 0;
      const actual = d.nutrition?.actualTotals?.protein  || 0;
      return target > 0 ? Math.abs(actual - target) / target * 100 : 0;
    });
    const avgProteinDevPct = Math.round(allDays.reduce((acc, d, i) => acc + allProteinDevs[i], 0) / allDays.length);
    const proteinDeficitDays = allDays.filter((d, i) => {
      const target = d.nutrition?.targetMacros?.protein || 0;
      const actual = d.nutrition?.actualTotals?.protein  || 0;
      return actual < target * 0.80;
    }).length;
    const proteinWarnings = allDays.flatMap(d => d.nutrition?.planWarnings || [])
      .filter(w => w.type === "PROTEIN_DEFICIT");
    const proteinSurplusDays = allDays.filter(d => {
      const target = d.nutrition?.targetMacros?.protein || 0;
      const actual = d.nutrition?.actualTotals?.protein  || 0;
      return actual > target * 1.30;
    }).length;

    console.log(`  Semanas generadas  : ${TOTAL_WEEKS}`);
    console.log(`  Días entrenamiento : ${trainingDays.length} | Días descanso: ${restDays.length}`);
    console.log(`  Ejercicios totales : ${totalExercises}`);
    console.log(`  Sesiones vacías    : ${emptyWorkouts} ${emptyWorkouts > 0 ? "⚠️" : "✓"}`);
    console.log(`  Comidas totales    : ${totalMeals}`);
    const restSurplusDays = restDays.filter(d => (d.nutrition?.calorieDeviation || 0) > d.nutrition?.targetCalories * 0.10).length;
    // [v24] contar días con rescue de más de 1 slot (snack + merienda)
    const multiRescueDays = allDays.filter(d => {
      const rMeals = (d.nutrition?.meals || []).filter(m => m.isRescueMeal);
      return rMeals.length > 1;
    }).length;
    console.log(`  Desviación cal/día : ~${Math.round(avgDevAll)} kcal total | entrenamiento: ~${Math.round(avgDevTrain)} kcal | descanso: ~${Math.round(avgDevRest)} kcal`);
    console.log(`  Días descanso surplus >10%: ${restSurplusDays}/${restDays.length} | multi-rescue días: ${multiRescueDays}`);
    console.log(`  Desviación x fase  : ${phaseStats.map(p => `${p.phase}:~${p.avg}kcal(n=${p.n})`).join(" | ")}`);
    const proteinSwaps = allDays.flatMap(d =>
      (d.nutrition?.meals || []).filter(m => m.wasProteinSwapped)
    ).length;
    console.log(`  Porciones extremas : ${extremePortions} slots con ×>1.8 | upscaled: ${upscaledMeals} | protein_swaps: ${proteinSwaps}`);
    console.log(`  Recetas únicas     : ${uniqueSlugs}/${allSlugs.length} (${diversityPct}% diversidad)`);
    console.log(`  Plan warnings      : ${warnings.length} (${warnings.filter(w => w.severity === "high").length} high, ${warnings.filter(w => w.severity === "medium").length} medium)\n`);
    console.log(`  Proteína avg dev   : ~${avgProteinDevPct}% | días déficit >20%: ${proteinDeficitDays} | días surplus >30%: ${proteinSurplusDays}`);
    console.log(`  Protein warnings   : ${proteinWarnings.length} (${proteinWarnings.filter(w => w.severity === "high").length} high, ${proteinWarnings.filter(w => w.severity === "medium").length} medium)`);
  });

  fs.writeFileSync(
    "./logs/events_all.jsonl",
    allEvents.map(e => JSON.stringify(e)).join("\n")
  );
  console.log(`✓ Log global: ./logs/events_all.jsonl (${allEvents.length} eventos totales)`);
  console.log("\n¡Listo! Planes en ./output — Logs en ./logs\n");
}

run();