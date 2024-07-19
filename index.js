import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { Storage } from "@google-cloud/storage";
import { v4 as uuidv4 } from "uuid";
import bodyParser from "body-parser";
import multer from "multer";
import path from "path";
import fs from "fs";
dotenv.config();

const app = express();
const port = 3000;

// Ensure the GOOGLE_APPLICATION_CREDENTIALS environment variable is set
const credentialsPath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);


if (!fs.existsSync(credentialsPath)) {
  throw new Error(`The file at ${credentialsPath} does not exist.`);
}

process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;

const storage = new Storage();
const bucketName = process.env.GCLOUD_STORAGE_BUCKET;

app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

const url = process.env.MONGODB_URL;
const upload = multer({ storage: multer.memoryStorage() });

const client = new MongoClient(url, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let profile, posts;

async function runDB() {
  try {
    await client.connect();
    console.log("MongoDB Connected!");
    const database = client.db("InstaEatsDB");
    posts = database.collection("Posts");
    profile = database.collection("Profile");
    const count = await posts.countDocuments();
    const count2 = await profile.countDocuments();
    console.log(
      `InstaEatsDB collection has ${count} posts and ${count2} profile documents.`
    );
  } catch (error) {
    console.error("Failed to connect MongoDB", error);
    process.exit(1);
  }
}

function ensureDBConnection(req, res, next) {
  if (!profile || !posts) {
    return res.status(500).send("Database not initialized");
  }
  next();
}

app.use(ensureDBConnection);

// Middleware to handle file uploads and update profile picture
app.post("/updateProfilePic", upload.single("image"), async (req, res) => {
  try {
    const { email } = req.body;
    const image = req.file;

    if (!image) {
      return res.status(400).send("Image is required");
    }

    const blob = storage
      .bucket(bucketName)
      .file(`profile_pics/${uuidv4()}${path.extname(image.originalname)}`);
    const blobStream = blob.createWriteStream({
      resumable: false,
      metadata: {
        contentType: image.mimetype,
      },
    });

    blobStream.on("error", (err) => {
      console.error(err);
      res.status(500).send("Failed to upload image");
    });

    blobStream.on("finish", async () => {
      const publicUrl = `https://storage.googleapis.com/${bucketName}/${blob.name}`;

      await profile.updateOne(
        { email: email },
        { $set: { profilePic: publicUrl } }
      );

      res.status(200).send({ url: publicUrl });
    });

    blobStream.end(image.buffer);
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal Server Error");
  }
});

// API route to edit profile information
app.post("/edit-profile", async (req, res) => {
  const { email, bio, userName } = req.body;

  try {
    const existingProfile = await profile.findOne({ email: email });

    if (existingProfile) {
      const result = await profile.updateOne(
        { email: email },
        { $set: { Bio: bio, userName: userName } }
      );
      if (result.modifiedCount > 0) {
        res.status(200).json({ message: "Profile updated successfully" });
      } else {
        res.status(500).json({ message: "Failed to update profile" });
      }
    } else {
      res.status(404).json({ message: "Profile not found" });
    }
  } catch (error) {
    console.error("Error updating profile:", error);
    res.status(500).json({ message: "Internal Server Error 500" });
  }
});

app.post("/uploadImage", upload.single("image"), async (req, res) => {
  try {
    const image = req.file;

    if (!image) {
      return res.status(400).send("Image is required");
    }

    const blob = storage
      .bucket(bucketName)
      .file(`post_images/${uuidv4()}${path.extname(image.originalname)}`);
    const blobStream = blob.createWriteStream({
      resumable: false,
      metadata: {
        contentType: image.mimetype,
      },
    });

    blobStream.on("error", (err) => {
      console.error(err);
      res.status(500).send(err);
    });

    blobStream.on("finish", async () => {
      const publicUrl = `https://storage.googleapis.com/${bucketName}/${blob.name}`;
      res.status(200).json({ url: publicUrl });
    });

    blobStream.end(image.buffer);
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal Server Error");
  }
});

app.post("/createPost", async (req, res) => {
  try {
    const date = new Date().toISOString();
    const {
      userName,
      imageUrl,
      placeName,
      googleMapUrl,
      profileId,
      caption,
      profilePic,
      rating,
    } = req.body;

    const newPost = await posts.insertOne({
      userName,
      imageUrl,
      placeName,
      googleMapUrl,
      likes: 0,
      date,
      profileId: new ObjectId(profileId),
      caption,
      profilePic,
      likeId: [],
      rating,
    });

    if (newPost.acknowledged) {
      const profileUpdate = await profile.updateOne(
        { _id: new ObjectId(profileId) },
        {
          $inc: { NoPosts: 1 },
          $addToSet: { Posts: newPost.insertedId.toString() },
        }
      );

      if (profileUpdate.modifiedCount > 0) {
        return res.status(201).json({
          message: "Post created successfully",
          postId: newPost.insertedId,
        });
      } else {
        await posts.deleteOne({ _id: newPost.insertedId });
        return res.status(500).json({
          message: "Failed to update profile after creating post",
        });
      }
    } else {
      return res.status(500).json({
        message: "Failed to create post",
      });
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: "Internal Server Error",
      error: error.message,
    });
  }
});

app.get("/profile/:emailId", async (req, res) => {
  try {
    const { emailId } = req.params;
    const profileInfo = await profile.findOne({ email: emailId });
    res.json(profileInfo);
  } catch (error) {
    console.log(error);
    return res.status(500).send("Internal Error");
  }
});

app.get("/post/:postId", async (req, res) => {
  try {
    const { postId } = req.params;
    const objectId = new ObjectId(postId);
    const allPosts = await posts.findOne({ _id: objectId });
    res.json(allPosts);
  } catch (error) {
    console.log(error);
    return res.status(500).send("Internal Error");
  }
});

app.post("/DeletePost", async (req, res) => {
  try {
    const { postId } = req.body;
    const objectId = new ObjectId(postId);

    const postD = await posts.findOne({ _id: objectId });
    if (postD) {
      const deletePost = await posts.deleteOne({ _id: objectId });
      const pullPost = await profile.updateOne(
        { _id: postD.profileId },
        {
          $pull: { Posts: postId },
          $inc: { NoPosts: -1 },
        }
      );
      return res.json(deletePost);
    } else {
      return res.status(404).send("Post not found");
    }
  } catch (error) {
    console.log(error);
    return res.status(500).send("Internal Error");
  }
});

app.post("/DeleteProfile", async (req, res) => {
  try {
    const { profileId } = req.body;
    const objectId = new ObjectId(profileId);

    const profileD = await profile.findOne({ _id: objectId });
    if (profileD) {
      const deleteProfile = await profile.deleteOne({ _id: objectId });
      const deletePosts = await posts.deleteMany({ profileId: objectId });
      return res.json({ deleteProfile, deletePosts });
    } else {
      return res.status(404).send("Profile not found");
    }
  } catch (error) {
    console.log(error);
    return res.status(500).send("Internal Error");
  }
});

app.post("/Addlike", async (req, res) => {
  try {
    const { id, profileId } = req.body;
    const objectId = new ObjectId(id);
    const result = await posts.updateOne(
      { _id: objectId },
      {
        $inc: { likes: 1 },
        $addToSet: { likeId: profileId },
      }
    );
    res.json(result);
  } catch (error) {
    console.log(error);
    return res.status(500).send("Internal Error");
  }
});

app.post("/SavePost", async (req, res) => {
  try {
    const { postId, profileId } = req.body;
    const post = new ObjectId(postId);
    const profileIdObj = new ObjectId(profileId);
    const result = await profile.updateOne(
      { _id: profileIdObj },
      {
        $addToSet: { savedPost: post },
      }
    );
    res.json(result);
  } catch (error) {
    console.log(error);
    return res.status(500).send("Internal Error");
  }
});

app.post("/RemoveSavedPost", async (req, res) => {
  try {
    const { postId, profileId } = req.body;
    const post = new ObjectId(postId);
    const profileIdObj = new ObjectId(profileId);
    const result = await profile.updateOne(
      { _id: profileIdObj },
      {
        $pull: { savedPost: post },
      }
    );
    res.json(result);
  } catch (error) {
    console.log(error);
    return res.status(500).send("Internal Error");
  }
});

app.post("/createProfile", async (req, res) => {
  try {
    const { Name, username, profilePic, bio, email } = req.body;

    if (!Name || !username || !email) {
      return res
        .status(400)
        .json({ message: "Name, username, and email are required" });
    }

    const existingProfile = await profile.findOne({ email });
    if (existingProfile) {
      return res
        .status(400)
        .json({ message: "Profile with this email already exists" });
    }

    const result = await profile.insertOne({
      Name,
      username,
      profilePic,
      Posts: [],
      Bio: bio || "",
      email,
    });

    res.status(201).json({
      message: "Profile created successfully",
      profile: result,
    });
  } catch (error) {
    console.error("Error creating profile:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

app.get("/search", async (req, res) => {
  try {
    const { input } = req.query;

    const post = await posts
      .find({
        $or: [
          { username: { $regex: input, $options: "i" } },
          { placeName: { $regex: input, $options: "i" } },
          { caption: { $regex: input, $options: "i" } },
          { googleMapUrl: { $regex: input, $options: "i" } },
        ],
      })
      .toArray();

    res.json(post);
  } catch (error) {
    return res.status(500).send("Internal Error");
  }
});

app.get("/", async (req, res) => {
  try {
    const allPosts = await posts.find({}).toArray();
    res.json(allPosts);
  } catch (error) {
    console.log(error);
    return res.status(500).send("Internal Error");
  }
});

async function startServer() {
  await runDB();
  app.listen(port, () => {
    console.log(`Server started on port ${port}!`);
  });
}

startServer();
