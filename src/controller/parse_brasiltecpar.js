
const url = require('url');
const path = require('path');

const PlayerConfiguration = require('../util/player_configuration');
const DashMpdParser = require('../dash_parser');
const logger = require('../util/logger');

const getSegmentsNumberForDuration = (timeLineList, duration) => {
    let durationSum = 0;
    let segmentNum = 0;
    for (let i = timeLineList.length - 1; i >= 0; i--) {
        durationSum += timeLineList[i].end - timeLineList[i].start;
        segmentNum++;
        if (durationSum >= duration) {
            break;
        }
    }

    return segmentNum;
}

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
    // will be specified by input param
    const segmentBufferLen = 10;
    const timeDuration = 2;
    const videoInitSegmentIndex = video.segmentIndex.indexes_[0].initSegmentReference_;
    const videoSegmentIndex = video.segmentIndex;
    const videototalNum = videoSegmentIndex.indexes_[0].getNumReferences();

    const videoTimelines = videoSegmentIndex.indexes_[0].templateInfo_.timeline;
    
    const videoSegmentsNum = getSegmentsNumberForDuration(videoTimelines,  timeDuration);

    const audioData = [];
    const audioInitSegmentIndex = audio.segmentIndex.indexes_[0].initSegmentReference_;
    const audioSegmentIndex = audio.segmentIndex;
    const audiototalNum = audioSegmentIndex.indexes_[0].getNumReferences();
    const audioTimelines = audioSegmentIndex.indexes_[0].templateInfo_.timeline;
    const audioSegmentsNum = getSegmentsNumberForDuration(audioTimelines, timeDuration)

    logger.info(`returning ${videoSegmentsNum} video segments and ${audioSegmentsNum} audio ones for latest ${timeDuration} seconds..`);

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

    for (let i = videoSegmentsNum; i > 0; i--) {
        const videoUri = videoSegmentIndex.get(videototalNum - i).getUrisInner();
        const videoSegmentNum = path.basename(videoUri[0], path.extname(videoUri[0]));
        videoSegIdx = videoSegmentNum.replace(/\D/g, '');

        videoData.push({
            segment: parseInt(videoSegIdx),
            type: "media",
            uri: videoUri[0]
        });
    }

    for (let i = audioSegmentsNum; i > 0; i--) {
        const audioUri = audioSegmentIndex.get(audiototalNum - i).getUrisInner();
        const audioSegmentNum = path.basename(audioUri[0], path.extname(audioUri[0]));
        audioSegIdx = audioSegmentNum.replace(/\D/g, '');

        audioData.push({
            segment: parseInt(audioSegIdx),
            type: "media",
            uri: audioUri[0]
        });
    }

    responseData.video = videoData;
    responseData.audio = audioData;

    res.json(responseData);
};

module.exports = ParserBrasiltecpar;