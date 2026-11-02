import { Router } from "express";
import mongoose from "mongoose";
import { documentStorage } from "../lib/document-storage.js";
import { readUpload, sniffMime } from "../lib/documents.js";
import { Business } from "../models/Business.js";
import { MAX_IMAGES, MAX_IMAGE_BYTES, MAX_PRODUCTS, Product, productKinds } from "../models/Product.js";
import { ApiError } from "../middleware/errors.js";
import { requirePaidRegistration } from "../middleware/paid.js";
import { requireAuth, requireRole } from "../middleware/security.js";
import { idParamSchema, productPatchSchema, productSchema } from "../schemas.js";

function parseId(value) {
  const parsed = idParamSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(404, "not_found", "Not found.");
  return parsed.data;
}

const imageMb = (config) => Math.floor(Math.min(MAX_IMAGE_BYTES, config.documents.maxFileBytes) / (1024 * 1024));

/** Sends a product picture. A missing or altered file is a plain 404. */
export async function sendProductImage(res, image) {
  let bytes;
  try {
    bytes = await documentStorage.read(image);
  } catch {
    throw new ApiError(404, "not_found", "Not found.");
  }
  res.set({
    "Content-Type": image.mime,
    "Content-Disposition": `inline; filename="picture.${image.mime === "image/png" ? "png" : "jpg"}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Length": String(bytes.length),
  });
  res.end(bytes);
}

/** Removes the files of a product's pictures from the disk. */
export async function removeProductImages(products) {
  for (const p of products) for (const image of p.images ?? []) await documentStorage.remove(image.storageKey);
}

/** The products and services of the owner's business: list, add, change and remove, and their pictures. */
export function productRoutes({ config }) {
  const router = Router();
  router.use(requireAuth(config), requireRole("msme_owner"), requirePaidRegistration(config));

  router.get("/", async (req, res) => {
    const items = await Product.find({ owner: req.user._id }).sort({ createdAt: -1 });
    res.json({ items, total: items.length, limit: MAX_PRODUCTS, kinds: productKinds, images: { available: documentStorage.enabled, maxPerProduct: MAX_IMAGES, maxMb: imageMb(config), types: ["JPEG", "PNG"] } });
  });

  router.post("/", async (req, res) => {
    const input = productSchema.parse(req.body);
    const business = await Business.findOne({ owner: req.user._id }).select("_id");
    if (!business) throw new ApiError(404, "not_found", "Business profile not found.");
    if ((await Product.countDocuments({ owner: req.user._id })) >= MAX_PRODUCTS) {
      throw new ApiError(422, "product_limit", `You can list up to ${MAX_PRODUCTS} products and services. Remove one first.`);
    }
    const item = await Product.create({ ...input, owner: req.user._id, business: business._id });
    res.status(201).json({ product: item });
  });

  router.patch("/:id", async (req, res) => {
    const item = await Product.findOne({ _id: parseId(req.params.id), owner: req.user._id });
    if (!item) throw new ApiError(404, "not_found", "Not found.");
    Object.assign(item, productPatchSchema.parse(req.body));
    await item.save();
    res.json({ product: item });
  });

  router.delete("/:id", async (req, res) => {
    const item = await Product.findOne({ _id: parseId(req.params.id), owner: req.user._id });
    if (!item) throw new ApiError(404, "not_found", "Not found.");
    await removeProductImages([item]);
    await item.deleteOne();
    res.status(204).end();
  });

  // Add a picture: multipart form data with one part, `file`, a JPEG or PNG. Decided from the first bytes, not the name.
  router.post("/:id/images", async (req, res) => {
    if (!documentStorage.enabled) throw new ApiError(503, "images_unavailable", "Pictures are not available right now. Please try again later.");
    const item = await Product.findOne({ _id: parseId(req.params.id), owner: req.user._id });
    if (!item) throw new ApiError(404, "not_found", "Not found.");
    const { buffer, fields } = await readUpload(req, { ...config.documents, maxFileBytes: Math.min(MAX_IMAGE_BYTES, config.documents.maxFileBytes) });
    if (Object.keys(fields).length > 0) throw new ApiError(422, "validation", "Please check the highlighted fields.", { _: "Send only the file." });
    const mime = sniffMime(buffer);
    if (mime !== "image/jpeg" && mime !== "image/png") throw new ApiError(422, "unsupported_file", "Upload a JPEG or PNG picture.", { file: "Upload a JPEG or PNG picture." });
    if (item.images.length >= MAX_IMAGES) throw new ApiError(422, "image_limit", `A product can have up to ${MAX_IMAGES} pictures. Remove one first.`);

    const stored = await documentStorage.save(buffer);
    try {
      // Added in one step against the count, so two uploads at once cannot go over the limit.
      const updated = await Product.findOneAndUpdate(
        { _id: item._id, owner: req.user._id, [`images.${MAX_IMAGES - 1}`]: mongoose.trusted({ $exists: false }) },
        { $push: { images: { mime, size: buffer.length, ...stored } } },
        { returnDocument: "after" },
      );
      if (!updated) throw new ApiError(422, "image_limit", `A product can have up to ${MAX_IMAGES} pictures. Remove one first.`);
      res.status(201).json({ product: updated });
    } catch (err) {
      await documentStorage.remove(stored.storageKey); // do not leave an unreferenced file behind
      throw err;
    }
  });

  router.get("/:id/images/:imageId", async (req, res) => {
    const item = await Product.findOne({ _id: parseId(req.params.id), owner: req.user._id });
    const image = item?.images.find((i) => String(i._id) === parseId(req.params.imageId));
    if (!image) throw new ApiError(404, "not_found", "Not found.");
    await sendProductImage(res, image);
  });

  router.delete("/:id/images/:imageId", async (req, res) => {
    const item = await Product.findOne({ _id: parseId(req.params.id), owner: req.user._id });
    const image = item?.images.find((i) => String(i._id) === parseId(req.params.imageId));
    if (!item || !image) throw new ApiError(404, "not_found", "Not found.");
    await documentStorage.remove(image.storageKey);
    item.images.pull(image._id);
    await item.save();
    res.status(204).end();
  });

  return router;
}
