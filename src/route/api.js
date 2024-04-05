const express = require("express");
const router = new express.Router();

const ParserBrasiltecpar = require('../controller/parse_brasiltecpar');

router.post("/parsempd", ParserBrasiltecpar);
module.exports = router;
