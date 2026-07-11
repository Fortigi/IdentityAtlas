// Entity-detail endpoints (barrel).
//
// This controller grew past the ~600-line "smell" threshold (audit finding C1),
// so it's split by entity into focused per-router modules under ./details/:
//
//   details/user.js          — /api/user/:id + sub-resources
//   details/group.js         — /api/group/:id + sub-resources
//   details/accessPackage.js — /api/access-package/:id + sub-resources
//   details/shared.js        — cleanRow / getPermissionTable / fetchHistory /
//                              countHistory + the useSql / UUID_RE constants
//
// This file just composes them onto one router and re-exports it, so the mount
// in app.js (`app.use('/api', authMiddleware, detailsRouter)`) and every public
// path are unchanged.

import { Router } from 'express';
import userRouter from './details/user.js';
import groupRouter from './details/group.js';
import accessPackageRouter from './details/accessPackage.js';

const router = Router();
router.use(userRouter);
router.use(groupRouter);
router.use(accessPackageRouter);

export default router;
