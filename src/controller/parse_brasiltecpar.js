
const url = require('url');
const path = require('path');

const PlayerConfiguration = require('../util/player_configuration');
const DashMpdParser = require('../dash_parser');
const { parse } = require('path');
const logger = require('../util/logger');

const ParserBrasiltecpar = async (req, res) => {
    const payload = req.body;
    const mpdUrl = payload.url;
    const videoRepId = payload.video.representation_id;
    const audioRepId = payload.audio.representation_id;
    const requestHeader = payload.headers;
    const numSegments = payload.numSegments;

    const parsedUrl = new url.URL(mpdUrl);
    const baseUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}${parsedUrl.pathname}`

    const config = PlayerConfiguration.createDefault().manifest;
    mpdParser = new DashMpdParser();
    mpdParser.configure(config);
    await mpdParser.start(mpdUrl, baseUrl, requestHeader);

    const parsedResult = mpdParser.manifest_;

    if (!parsedResult) {
        return res.json({});
    }

    let targetStream = null;

    const audio = parsedResult.variants[0].audio;
    const video = parsedResult.variants[0].video;

    await audio.createSegmentIndex();
    await video.createSegmentIndex();

    const responseData = {};
    const videoData = [];
    const videoInitSegmentIndex = video.segmentIndex.indexes_[0].initSegmentReference_;
    const videoSegmentIndex = video.segmentIndex;
    const totalNum = videoSegmentIndex.indexes_[0].getNumReferences();

    logger.info(`${totalNum} segments are available in this mpd`);

    videoData.push({
        segment: 0,
        type: "initialization",
        uri: videoInitSegmentIndex.getUris()[0]
    });

    // get lateseet 10 segments
    for (let i = 10; i > 0; i--) {
        const uri = videoSegmentIndex.get(totalNum - i).getUrisInner();
        const segmentNum = path.basename(uri[0], path.extname(uri[0]));

        videoData.push({
            segment: segmentNum,
            type: "media",
            uri: uri[0]
        });
    }

    const audioData = [];
    const audioInitSegmentIndex = audio.segmentIndex.indexes_[0].initSegmentReference_;
    const audioSegmentIndex = audio.segmentIndex;
    const audiototalNum = audioSegmentIndex.indexes_[0].getNumReferences();

    audioData.push({
        segment: 0,
        type: "initialization",
        uri: audioInitSegmentIndex.getUris()[0]
    });

    // get lateseet 10 segments
    for (let i = 10; i > 0; i--) {
        const uri = audioSegmentIndex.get(audiototalNum - i).getUrisInner();
        const segmentNum = path.basename(uri[0], path.extname(uri[0]));

        audioData.push({
            segment: segmentNum,
            type: "media",
            uri: uri[0]
        });
    }

    responseData.video = videoData;
    responseData.audio = audioData;

    res.json(responseData);
};

module.exports = ParserBrasiltecpar;