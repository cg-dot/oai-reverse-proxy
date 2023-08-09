import { Router } from "express";

const loginRouter = Router();

loginRouter.get("/login", (req, res) => {
  res.render("admin/login", { failed: req.query.failed });
});

loginRouter.post("/login", (req, res) => {
  res.cookie("admin-token", req.body.token, {
    maxAge: 1000 * 60 * 60 * 24 * 14,
    httpOnly: true,
  });
  res.redirect("/admin");
});

loginRouter.get("/logout", (req, res) => {
  res.clearCookie("admin-token");
  res.redirect("/admin/login");
});

export { loginRouter };
