
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

    logger.info(`Parsing mpd ${mpdUrl} with rep id ${videoRepId}, ${audioRepId}`);
    await mpdParser.start(mpdUrl, baseUrl, requestHeader);

    const parsedResult = mpdParser.manifest_;

    if (!parsedResult) {
        return res.json({});
    }

    let targetStream = null;

    for (const variant of parsedResult.variants) {
        if (variant.audio.originalId == audioRepId &&
            variant.video.originalId == videoRepId) {
            targetStream = variant;
            break;
        }
    }

    if (!targetStream) {
        return res.json({});
    }

    const audio = targetStream.audio;
    const video = targetStream.video;

    await audio.createSegmentIndex();
    await video.createSegmentIndex();

    const responseData = {};
    const videoData = [];
    const videoInitSegmentIndex = video.segmentIndex.indexes_[0].initSegmentReference_;
    const videoSegmentIndex = video.segmentIndex;
    const videototalNum = videoSegmentIndex.indexes_[0].getNumReferences();

    const audioData = [];
    const audioInitSegmentIndex = audio.segmentIndex.indexes_[0].initSegmentReference_;
    const audioSegmentIndex = audio.segmentIndex;
    const audiototalNum = audioSegmentIndex.indexes_[0].getNumReferences();


    logger.info(`Total Segments number: ${totalSegmentNum}`);

    // Get init segment information
    videoData.push({
        segment: 0,
        type: "initialization",
        uri: videoInitSegmentIndex.getUris()[0]
    });

    audioData.push({
        segment: 0,
        type: "initialization",
        uri: audioInitSegmentIndex.getUris()[0]
    });

    // get lateseet segments
    let catchedSegments = 0;
    let i = 0;
    const audioSegmentList = [];
    const videoSegmentList = [];
    let found = false;

    while (true) {
        const videoUri = videoSegmentIndex.get(videototalNum - i).getUrisInner();
        const videoSegmentNum = path.basename(videoUri[0], path.extname(videoUri[0]));
        const digitedIndex = videoSegmentNum.replace(/\D/g, '');

        const audioUri = audioSegmentIndex.get(audiototalNum - i).getUrisInner();
        const audioSegmentNum = path.basename(audioUri[0], path.extname(audioUri[0]));
        const audiodigitedIndex = audioSegmentNum.replace(/\D/g, '');

        audioSegmentList.push({
            segment: parseInt(audiodigitedIndex),
            type: "media",
            uri: audioUri[0]
        });

        videoSegmentList.push({
            segment: parseInt(digitedIndex),
            type: "media",
            uri: videoUri[0]
        });

        i++;
    }

    responseData.video = videoData;
    responseData.audio = audioData;

    res.json(responseData);
};

module.exports = ParserBrasiltecpar;