/// LMU REST API client — Task 19 will implement full polling
/// Used for Virtual Energy (VE) and hybrid data (~5Hz)

pub struct RestApiClient {
    base_url: String,
}

impl RestApiClient {
    pub fn new(base_url: String) -> Self {
        RestApiClient { base_url }
    }
}
