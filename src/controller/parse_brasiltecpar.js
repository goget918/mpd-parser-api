const url = require('url');
const path = require('path');

const PlayerConfiguration = require('../util/player_configuration');
const DashMpdParser = require('../dash_parser');
const logger = require('../util/logger');

const toEpochTime = (presentationStartTime, seconds) => {
    return Math.floor(presentationStartTime + seconds);
};


const ParserBrasiltecpar = async (req, res) => {
    try {
        const {
            url: mpdUrl,
            video: { representation_id: videoRepId },
            audio: { representation_id: audioRepId },
            headers: requestHeader,
            numSegments,
            bufferLength: timeDuration,
            proxy: proxy
        } = req.body;

        const parsedUrl = new url.URL(mpdUrl);
        const baseUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}${parsedUrl.pathname}`;

        const config = PlayerConfiguration.createDefault().manifest;
        const mpdParser = new DashMpdParser();
        mpdParser.configure(config);

        logger.info(`Parsing mpd ${mpdUrl} with rep id ${videoRepId}, ${audioRepId}`);
        await mpdParser.start(mpdUrl, baseUrl, requestHeader, proxy);

        const parsedResult = mpdParser.manifest_;
        const presentationStartTime = parsedResult.presentationTimeline.getPresentationStartTime();
        const timeShiftBufferDepth = parsedResult.presentationTimeline.segmentAvailabilityDuration_;
        const nSegments = Math.ceil(timeDuration/parsedResult.presentationTimeline.maxSegmentDuration_);

        if (!parsedResult) {
            return res.json({});
        }

        const targetStream = parsedResult.variants.find(variant => variant.audio.originalId === audioRepId && variant.video.originalId === videoRepId);

        if (!targetStream) {
            return res.json({});
        }

        const audio = targetStream.audio;
        const video = targetStream.video;

        await Promise.all([audio.createSegmentIndex(), video.createSegmentIndex()]);

        const responseData = {
            maxSegmentDuration: parsedResult.presentationTimeline.maxSegmentDuration_,
            timeShiftBufferDepth,
            video: [],
            audio: []
        };

        const processSegmentData = (segmentIndex, mediaData, timescale) => {
            const initSegmentUri = segmentIndex.get(0).initSegmentReference.getUris()[0];
            mediaData.push({
                segment: 0,
                type: "initialization",
                uri: initSegmentUri
            });

            if (segmentIndex.indexes_) {
                const refNum = segmentIndex.indexes_[0].references.length;
                for (let i = refNum - nSegments > 0 ? refNum - nSegments : 0; i < refNum; i++) {
                    const reference = segmentIndex.indexes_[0].references[i];
                    const segmentUri = reference.getUrisInner()[0];
                    const segmentNum = toEpochTime(presentationStartTime, reference.startTime / timescale);

                    mediaData.push({
                        segment: segmentNum,
                        type: "media",
                        start: toEpochTime(presentationStartTime, reference.startTime / timescale),
                        stop: toEpochTime(presentationStartTime, reference.endTime / timescale),
                        duration: Math.ceil((reference.endTime - reference.startTime) / timescale),
                        uri: segmentUri
                    });
                }
            } else {
                const refNum = segmentIndex.getNumReferences();
                for (let i = refNum - nSegments; i < refNum; i++) {
                    const reference = segmentIndex.get(i);
                    const segmentUri = reference.getUrisInner()[0];
                    const segmentNum = toEpochTime(presentationStartTime, reference.startTime / timescale);

                    mediaData.push({
                        segment: segmentNum,
                        type: "media",
                        start: toEpochTime(presentationStartTime, reference.startTime / timescale),
                        stop: toEpochTime(presentationStartTime, reference.endTime / timescale),
                        duration: Math.ceil((reference.endTime - reference.startTime) / timescale),
                        uri: segmentUri
                    });
                }
            }
        };


        const videoSegmentIndex = video.segmentIndex;
        const audioSegmentIndex = audio.segmentIndex;
        let videoTimescale = 1;
        let audioTimescale = 1;

        processSegmentData(videoSegmentIndex, responseData.video, videoTimescale);
        processSegmentData(audioSegmentIndex, responseData.audio, audioTimescale);

        logger.info(`returning ${responseData.video.length} video segments and ${responseData.audio.length} audio ones for latest ${timeDuration} seconds..`);

        res.json(responseData);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal Server Error" });
    }
};

module.exports = ParserBrasiltecpar;
