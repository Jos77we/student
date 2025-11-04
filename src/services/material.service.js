// src/services/material.service.js
import { Material } from '../models/material.model.js';

export const findMaterialsByTopic = async (topic) => {
  try {
    const results = await Material.find(
      { $text: { $search: topic } },
      { score: { $meta: 'textScore' } }
    ).sort({ score: { $meta: 'textScore' } });
    return results;
  } catch (error) {
    console.error('❌ Error fetching materials by topic:', error);
    return [];
  }
};
