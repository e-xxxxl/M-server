import mongoose from "mongoose";

/**
 * A local government area, belonging to one state. The list starts from the supplied file (src/data/lgas.json) and is
 * then managed by the super admin. A turned-off area is not offered in the dropdowns any more, but businesses that already
 * carry its name keep it.
 */
const lgaSchema = new mongoose.Schema(
  {
    state: { type: String, required: true, maxlength: 60, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// One name once per state, whatever the capital letters.
lgaSchema.index({ state: 1, name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

export const Lga = mongoose.models.Lga ?? mongoose.model("Lga", lgaSchema);
